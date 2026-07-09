import { FilesetResolver, FaceLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";

export type LipsyncDelegate = "CPU" | "GPU";

export interface DetectOptions {
  /** Sampling rate in frames per second. Default 15. */
  fps?: number;
  /** Maximum |lag| to search, in seconds. Default 1.0. */
  maxLagSec?: number;
  /** MediaPipe compute delegate. GPU is 2–5× faster on machines with a real GPU. */
  delegate?: LipsyncDelegate;
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
  /** Delegate actually used (may differ from requested if GPU init failed). */
  delegateUsed: LipsyncDelegate;
}

// Cache one landmarker per delegate — GPU init is expensive.
const landmarkerCache = new Map<LipsyncDelegate, Promise<FaceLandmarker>>();

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(id);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(id);
        reject(err);
      },
    );
  });
}

async function createLandmarker(delegate: LipsyncDelegate): Promise<FaceLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
  );
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate,
    },
    runningMode: "VIDEO",
    numFaces: 1,
  });
}

async function getLandmarker(delegate: LipsyncDelegate): Promise<{ landmarker: FaceLandmarker; used: LipsyncDelegate }> {
  const tryGet = (d: LipsyncDelegate) => {
    let p = landmarkerCache.get(d);
    if (!p) {
      p = createLandmarker(d).catch((err) => {
        landmarkerCache.delete(d);
        throw err;
      });
      landmarkerCache.set(d, p);
    }
    return p;
  };
  try {
    return { landmarker: await tryGet(delegate), used: delegate };
  } catch (err) {
    if (delegate === "GPU") {
      // eslint-disable-next-line no-console
      console.warn("[lipsync] GPU delegate failed, falling back to CPU", err);
      return { landmarker: await tryGet("CPU"), used: "CPU" };
    }
    throw err;
  }
}

async function getLandmarkerWithTimeout(
  delegate: LipsyncDelegate,
): Promise<{ landmarker: FaceLandmarker; used: LipsyncDelegate }> {
  if (delegate === "GPU") {
    try {
      return await withTimeout(getLandmarker("GPU"), 15_000, "GPU face model timed out");
    } catch (err) {
      landmarkerCache.delete("GPU");
      // eslint-disable-next-line no-console
      console.warn("[lipsync] GPU delegate unavailable, falling back to CPU", err);
      return {
        landmarker: await withTimeout(getLandmarker("CPU"), 30_000, "CPU face model timed out"),
        used: "CPU",
      };
    }
  }
  return await withTimeout(getLandmarker("CPU"), 30_000, "CPU face model timed out");
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

function smooth(a: Float32Array, radius: number): Float32Array {
  if (radius <= 0 || a.length <= 2) return new Float32Array(a);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(a.length - 1, i + radius); j++) {
      sum += a[j];
      count++;
    }
    out[i] = sum / Math.max(1, count);
  }
  return out;
}

function motionSignal(a: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  out[0] = 0;
  for (let i = 1; i < a.length; i++) out[i] = Math.abs(a[i] - a[i - 1]);
  return smooth(out, 1);
}

function maxValue(a: Float32Array): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > max) max = a[i];
  return max;
}

function rangeValue(a: Float32Array): number {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
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

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("Could not load preview clip")), { once: true });
    }),
    10_000,
    "Timed out loading preview metadata",
  );
}

function seekTo(video: HTMLVideoElement, seconds: number, timeoutMs = 1_500): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
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
        video.currentTime = seconds;
      } catch {
        finish();
      }
      window.setTimeout(finish, timeoutMs);
    }),
    timeoutMs + 250,
    "Timed out seeking video frame",
  );
}

function waitForPaintedFrame(video: HTMLVideoElement, timeoutMs = 250): Promise<void> {
  const rvfc = (
    video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    }
  ).requestVideoFrameCallback?.bind(video);
  return withTimeout(
    new Promise<void>((resolve) => {
      if (rvfc) rvfc(() => resolve());
      else requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }),
    timeoutMs,
    "Timed out waiting for video frame",
  ).catch(() => undefined);
}

function detectMouthAt(
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  timestampMs: number,
): number {
  try {
    const res = landmarker.detectForVideo(video, timestampMs);
    const lm = res.faceLandmarks?.[0];
    return lm ? mouthAperture(lm) : NaN;
  } catch {
    return NaN;
  }
}

async function sampleMouthByPlayback(
  video: HTMLVideoElement,
  landmarker: FaceLandmarker,
  fps: number,
  duration: number,
  report: (label: string, pct: number) => void,
): Promise<Float32Array | null> {
  const rvfc = (
    video as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        cb: (_now: number, metadata: { mediaTime?: number; presentationTime?: number }) => void,
      ) => number;
    }
  ).requestVideoFrameCallback?.bind(video);
  if (!rvfc) return null;

  const frameCount = Math.max(8, Math.floor(duration * fps));
  const mouth = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) mouth[i] = NaN;

  await seekTo(video, 0, 1_500).catch(() => undefined);
  video.muted = true;
  video.playbackRate = Math.min(2, Math.max(1, video.playbackRate || 1));
  try {
    await withTimeout(video.play(), 2_500, "Muted analysis playback did not start");
  } catch {
    video.pause();
    return null;
  }

  let nextIdx = 0;
  let lastTimestamp = 0;
  const timeoutMs = Math.min(90_000, Math.max(15_000, duration * 2_500 + frameCount * 300));
  try {
    await withTimeout(
      new Promise<void>((resolve) => {
        const step = (_now: number, metadata: { mediaTime?: number; presentationTime?: number }) => {
          const mediaTime = metadata.mediaTime ?? video.currentTime;
          if (nextIdx >= frameCount || mediaTime >= duration || video.ended) {
            resolve();
            return;
          }

          const target = (nextIdx + 0.5) / fps;
          if (mediaTime + 0.02 >= target) {
            const timestamp = Math.max(lastTimestamp + 1, Math.round(mediaTime * 1000));
            lastTimestamp = timestamp;
            const value = detectMouthAt(landmarker, video, timestamp);
            do {
              mouth[nextIdx] = value;
              nextIdx++;
            } while (nextIdx < frameCount && (nextIdx + 0.5) / fps <= mediaTime + 0.02);

            if (nextIdx % 3 === 0) {
              report("Analysing frames…", 0.05 + 0.75 * (nextIdx / frameCount));
            }
          }

          rvfc(step);
        };
        rvfc(step);
      }),
      timeoutMs,
      "Timed out while analysing video frames",
    ).catch((err) => {
      // Return the frames collected so far; downstream face-coverage checks
      // decide whether this partial sample is useful. This prevents a late
      // timeout from discarding otherwise valid analysis data and then trying
      // to reuse the same VIDEO-mode landmarker with reset timestamps.
      // eslint-disable-next-line no-console
      console.warn("[lipsync] playback sampling ended early", err);
    });
  } finally {
    video.pause();
  }

  return mouth;
}

async function sampleMouthBySeeking(
  video: HTMLVideoElement,
  landmarker: FaceLandmarker,
  fps: number,
  duration: number,
  report: (label: string, pct: number) => void,
): Promise<Float32Array> {
  const frameCount = Math.max(8, Math.floor(duration * fps));
  const mouth = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) mouth[i] = NaN;
  let lastTimestamp = 0;

  for (let i = 0; i < frameCount; i++) {
    const t = (i + 0.5) / fps;
    if (t >= duration) break;
    await seekTo(video, t, 1_500).catch(() => undefined);
    await waitForPaintedFrame(video);
    const timestamp = Math.max(lastTimestamp + 1, Math.round(t * 1000));
    lastTimestamp = timestamp;
    mouth[i] = detectMouthAt(landmarker, video, timestamp);
    if (i % 3 === 0) report("Analysing frames…", 0.05 + 0.75 * (i / frameCount));
  }

  return mouth;
}

export async function detectLipSyncOffset(clip: Blob, opts: DetectOptions = {}): Promise<DetectResult> {
  const fps = Math.max(8, Math.min(30, opts.fps ?? 15));
  const maxLagSec = opts.maxLagSec ?? 1.0;
  const delegate: LipsyncDelegate = opts.delegate ?? "CPU";
  const report = (label: string, pct: number) => opts.onProgress?.(label, Math.max(0, Math.min(1, pct)));

  report(`Loading face model (${delegate})…`, 0);
  const { landmarker, used: delegateUsed } = await getLandmarkerWithTimeout(delegate);

  // Build a video element from the blob.
  const url = URL.createObjectURL(clip);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.style.position = "fixed";
  video.style.left = "-9999px";
  video.style.top = "0";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  try {
    document.body.appendChild(video);
    await waitForMetadata(video);
    // Some browsers report duration = Infinity for fragmented mp4 until seeked.
    let duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      await seekTo(video, 1e6, 2_000).catch(() => undefined);
      duration = video.duration;
      await seekTo(video, 0, 2_000).catch(() => undefined);
    }
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Zero-length clip");

    report("Analysing frames…", 0.05);
    const frameCount = Math.max(8, Math.floor(duration * fps));
    let mouth = await sampleMouthByPlayback(video, landmarker, fps, duration, report).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[lipsync] playback sampling failed, falling back to seeking", err);
      return null;
    });
    if (!mouth) {
      mouth = await sampleMouthBySeeking(video, landmarker, fps, duration, report);
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
    for (let i = 0; i < mouthFilled.length; i++) {
      const v = mouthFilled[i];
      if (v < mMin) mMin = v;
      if (v > mMax) mMax = v;
      mMean += v;
    }
    mMean /= mouthFilled.length || 1;
    const mouthRange = mMax - mMin;

    report("Decoding audio…", 0.9);
    const audio = await decodeAudioRms(clip, fps, duration);
    let aMax = 0;
    for (let i = 0; i < audio.length; i++) if (audio[i] > aMax) aMax = audio[i];

    report("Correlating…", 0.95);
    const n = Math.min(mouthFilled.length, audio.length);
    if (n < Math.max(8, fps)) throw new Error("Clip is too short for reliable auto-sync analysis.");
    const mouthMotion = motionSignal(smooth(mouthFilled.subarray(0, n), 2));
    const audioMotion = motionSignal(smooth(audio.subarray(0, n), 2));
    const mouthMotionPeak = maxValue(mouthMotion);
    const audioMotionPeak = maxValue(audioMotion);
    const m = zscore(mouthMotion);
    const a = zscore(audioMotion);

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
      mouthMotionPeak: Number(mouthMotionPeak.toFixed(4)),
      audioPeak: Number(aMax.toFixed(4)),
      audioMotionPeak: Number(audioMotionPeak.toFixed(4)),
      bestK,
      bestKF: Number(bestKF.toFixed(3)),
      bestCorr: Number(bestCorr.toFixed(3)),
      confidence: Number(confidence.toFixed(3)),
      delegateUsed,
    });

    if (mouthRange < 0.005) {
      throw new Error(
        `Mouth barely moves in this cue (range ${mouthRange.toFixed(3)}). Pick a cue where the presenter is talking clearly.`,
      );
    }
    if (aMax < 0.005) {
      throw new Error(`Clip audio is nearly silent (peak ${aMax.toFixed(3)}). Pick a cue with clear speech.`);
    }
    if (rangeValue(mouthMotion) < 0.0005 || mouthMotionPeak < 0.0005) {
      throw new Error("Mouth movement changes are too subtle in this cue. Pick a cue with clearer speech movement.");
    }
    if (audioMotionPeak < 0.0005) {
      throw new Error("Audio changes are too subtle in this cue. Pick a cue with clearer speech and less silence.");
    }
    if (bestCorr < 0.08 || confidence < 0.04) {
      throw new Error(
        `Could not find a reliable sync offset (confidence ${Math.round(confidence * 100)}%). Pick a cue with a clear face and clean speech.`,
      );
    }

    report("Done", 1);
    return {
      offsetSec: bestKF / fps,
      confidence,
      faceCoverage,
      frames: frameCount,
      delegateUsed,
    };

  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}
