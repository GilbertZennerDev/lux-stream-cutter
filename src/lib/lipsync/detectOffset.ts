import { FilesetResolver, FaceLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";

export interface DetectOptions {
  /** Sampling rate in frames per second. Default 15. */
  fps?: number;
  /** Maximum |lag| to search, in seconds. Default 1.0. */
  maxLagSec?: number;
  onProgress?: (label: string, pct: number) => void;
}

export interface DetectResult {
  /** Residual offset in seconds (positive = audio should be delayed further). */
  offsetSec: number;
  /** Correlation quality [0..1] — higher is better. */
  confidence: number;
  /** Fraction of sampled frames that produced a face detection. */
  faceCoverage: number;
  /** Number of frames sampled. */
  frames: number;
}

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

function getLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
      );
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        },
        runningMode: "VIDEO",
        numFaces: 1,
      });
    })();
  }
  return landmarkerPromise;
}

/** Vertical mouth aperture, normalised by face height. Returns NaN if unavailable. */
function mouthAperture(lm: NormalizedLandmark[]): number {
  // 13 = upper inner lip, 14 = lower inner lip (MediaPipe FaceMesh).
  // 10 = forehead top, 152 = chin bottom.
  const up = lm[13], lo = lm[14], top = lm[10], chin = lm[152];
  if (!up || !lo || !top || !chin) return NaN;
  const mouth = Math.hypot(up.x - lo.x, up.y - lo.y);
  const face = Math.hypot(top.x - chin.x, top.y - chin.y);
  if (face < 1e-6) return NaN;
  return mouth / face;
}

async function decodeAudioRms(blob: Blob, fps: number, durationSec: number): Promise<Float32Array> {
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const total = Math.max(1, Math.floor(durationSec * fps));
    const samplesPerFrame = Math.max(1, Math.floor(buf.sampleRate / fps));
    const out = new Float32Array(total);
    // Mixdown to mono, compute RMS per frame window.
    const ch = buf.numberOfChannels;
    const data: Float32Array[] = [];
    for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    for (let i = 0; i < total; i++) {
      const start = i * samplesPerFrame;
      const end = Math.min(buf.length, start + samplesPerFrame);
      let sum = 0;
      let n = 0;
      for (let s = start; s < end; s++) {
        let v = 0;
        for (let c = 0; c < ch; c++) v += data[c][s];
        v /= ch;
        sum += v * v;
        n++;
      }
      out[i] = n > 0 ? Math.sqrt(sum / n) : 0;
    }
    return out;
  } finally {
    try { await ctx.close(); } catch {}
  }
}

function zscore(a: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < a.length; i++) mean += a[i];
  mean /= a.length || 1;
  let variance = 0;
  for (let i = 0; i < a.length; i++) variance += (a[i] - mean) ** 2;
  variance /= a.length || 1;
  const std = Math.sqrt(variance) || 1;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] - mean) / std;
  return out;
}

/** Interpolate NaNs in a series (linear between known values, edge-extend). */
function fillNaNs(a: Float32Array): { filled: Float32Array; validCount: number } {
  const out = new Float32Array(a.length);
  let valid = 0;
  const known: number[] = [];
  for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) known.push(i);
  valid = known.length;
  if (known.length === 0) return { filled: out, validCount: 0 };
  for (let i = 0; i < a.length; i++) {
    if (!Number.isNaN(a[i])) { out[i] = a[i]; continue; }
    // find surrounding knowns
    let lo = -1, hi = -1;
    for (const k of known) { if (k < i) lo = k; if (k > i) { hi = k; break; } }
    if (lo === -1) out[i] = a[hi];
    else if (hi === -1) out[i] = a[lo];
    else {
      const t = (i - lo) / (hi - lo);
      out[i] = a[lo] * (1 - t) + a[hi] * t;
    }
  }
  return { filled: out, validCount: valid };
}

export async function detectLipSyncOffset(clip: Blob, opts: DetectOptions = {}): Promise<DetectResult> {
  const fps = opts.fps ?? 15;
  const maxLagSec = opts.maxLagSec ?? 1.0;
  const report = (label: string, pct: number) => opts.onProgress?.(label, Math.max(0, Math.min(1, pct)));

  report("Loading face model…", 0);
  const landmarker = await getLandmarker();

  // Build a video element from the blob.
  const url = URL.createObjectURL(clip);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Could not load preview clip"));
    });
    // Some browsers report duration = Infinity for fragmented mp4 until seeked.
    let duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      await new Promise<void>((resolve) => {
        video.currentTime = 1e6;
        video.onseeked = () => { duration = video.duration; resolve(); };
      });
      video.currentTime = 0;
      await new Promise<void>((resolve) => { video.onseeked = () => resolve(); });
    }
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Zero-length clip");

    const frameCount = Math.max(8, Math.floor(duration * fps));
    const mouth = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) mouth[i] = NaN;

    report("Analysing frames…", 0.05);
    // Some browsers (Chromium in particular) fire `seeked` before the new
    // frame is actually painted, so MediaPipe reads the previous frame and
    // mouth aperture ends up nearly constant → flat cross-correlation → 0
    // offset. Wait for a real painted frame via requestVideoFrameCallback
    // when available, and fall back to a double-rAF otherwise.
    const rvfc = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      }
    ).requestVideoFrameCallback?.bind(video);
    const waitForPaintedFrame = () =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        if (rvfc) {
          rvfc(() => finish());
        } else {
          requestAnimationFrame(() => requestAnimationFrame(() => finish()));
        }
        // Safety timeout — some browsers don't fire rVFC for paused seeks.
        setTimeout(finish, 150);
      });

    for (let i = 0; i < frameCount; i++) {
      const t = (i + 0.5) / fps;
      if (t >= duration) break;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          video.removeEventListener("seeked", finish);
          video.removeEventListener("error", finish);
          resolve();
        };
        video.addEventListener("seeked", finish);
        video.addEventListener("error", finish);
        try {
          video.currentTime = t;
        } catch {
          finish();
        }
        // Safety timeout in case `seeked` never fires (e.g. target ≈ current time).
        setTimeout(finish, 400);
      });
      await waitForPaintedFrame();
      try {
        const res = landmarker.detectForVideo(video, Math.round(t * 1000));
        const lm = res.faceLandmarks?.[0];
        mouth[i] = lm ? mouthAperture(lm) : NaN;
      } catch {
        mouth[i] = NaN;
      }
      if (i % 3 === 0) report("Analysing frames…", 0.05 + 0.75 * (i / frameCount));
    }

    const { filled: mouthFilled, validCount } = fillNaNs(mouth);
    const faceCoverage = validCount / frameCount;
    if (validCount < Math.max(6, frameCount * 0.25)) {
      throw new Error(`No consistent face detected (${Math.round(faceCoverage * 100)}% of frames). Pick a cue with the presenter clearly on-screen.`);
    }

    // Guard: if the mouth signal barely moves, cross-correlation is
    // meaningless and would return ~0. Report clearly instead of pretending
    // the offset is already perfect.
    let mMin = Infinity, mMax = -Infinity, mMean = 0;
    for (let i = 0; i < validCount; i++) {
      const v = mouthFilled[i];
      if (v < mMin) mMin = v;
      if (v > mMax) mMax = v;
      mMean += v;
    }
    mMean /= validCount || 1;
    const mouthRange = mMax - mMin;

    report("Decoding audio…", 0.9);
    const audio = await decodeAudioRms(clip, fps, duration);
    let aMax = 0;
    for (let i = 0; i < audio.length; i++) if (audio[i] > aMax) aMax = audio[i];

    report("Correlating…", 0.95);
    const n = Math.min(mouthFilled.length, audio.length);
    const m = zscore(mouthFilled.subarray(0, n));
    const a = zscore(audio.subarray(0, n));

    // Cross-correlate: shift audio by k frames.
    // corr[k] = mean over i of m[i] * a[i - k]. Best k > 0 => audio arrives earlier
    // than mouth in the clip => audio must be delayed further (positive offset).
    const maxLag = Math.min(Math.floor(maxLagSec * fps), Math.floor(n / 2));
    let bestK = 0;
    let bestCorr = -Infinity;
    const corrs: number[] = [];
    for (let k = -maxLag; k <= maxLag; k++) {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < n; i++) {
        const j = i - k;
        if (j < 0 || j >= n) continue;
        sum += m[i] * a[j];
        count++;
      }
      const c = count > 0 ? sum / count : 0;
      corrs.push(c);
      if (c > bestCorr) { bestCorr = c; bestK = k; }
    }
    // Sub-frame interpolation via parabolic peak fit.
    let bestKF = bestK;
    const idx = bestK + maxLag;
    if (idx > 0 && idx < corrs.length - 1) {
      const y0 = corrs[idx - 1], y1 = corrs[idx], y2 = corrs[idx + 1];
      const denom = y0 - 2 * y1 + y2;
      if (Math.abs(denom) > 1e-9) {
        const delta = 0.5 * (y0 - y2) / denom;
        if (Math.abs(delta) < 1) bestKF = bestK + delta;
      }
    }

    // Confidence: peak vs mean of magnitudes.
    let meanAbs = 0;
    for (const c of corrs) meanAbs += Math.abs(c);
    meanAbs /= corrs.length || 1;
    const confidence = Math.max(0, Math.min(1, (bestCorr - meanAbs) / (Math.abs(bestCorr) + meanAbs + 1e-6)));

    // eslint-disable-next-line no-console
    console.info("[lipsync]", {
      duration,
      frameCount,
      faceCoverage: Number(faceCoverage.toFixed(2)),
      mouthRange: Number(mouthRange.toFixed(4)),
      mouthMean: Number(mMean.toFixed(4)),
      audioPeak: Number(aMax.toFixed(4)),
      bestK,
      bestKF: Number(bestKF.toFixed(3)),
      bestCorr: Number(bestCorr.toFixed(3)),
      confidence: Number(confidence.toFixed(3)),
    });

    if (mouthRange < 0.005) {
      throw new Error(
        `Mouth barely moves in this cue (range ${mouthRange.toFixed(3)}). Pick a cue where the presenter is talking clearly.`,
      );
    }
    if (aMax < 0.005) {
      throw new Error(`Clip audio is nearly silent (peak ${aMax.toFixed(3)}). Pick a cue with clear speech.`);
    }

    report("Done", 1);
    return {
      offsetSec: bestKF / fps,
      confidence,
      faceCoverage,
      frames: frameCount,
    };

  } finally {
    URL.revokeObjectURL(url);
  }
}
