import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, onProgress, type ProgressCb } from "./client";
import { formatSeconds } from "../subtitles/parseTime";

export interface PerfOptions {
  /** Optimise for weak hardware: ultrafast preset, higher CRF, downscale, single thread. */
  lowPerf?: boolean;
  /** Max video height when re-encoding (only used if lowPerf or explicitly set). */
  maxHeight?: number;
}

function encodeArgs(perf: PerfOptions): string[] {
  const preset = perf.lowPerf ? "ultrafast" : "veryfast";
  const crf = perf.lowPerf ? "28" : "22";
  return [
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", crf,
    "-tune", "fastdecode",
    "-pix_fmt", "yuv420p",
  ];
}

function threadArgs(perf: PerfOptions): string[] {
  // ffmpeg.wasm runs in a worker; keep threads low on weak machines to avoid OOM.
  return perf.lowPerf ? ["-threads", "1"] : ["-threads", "2"];
}

function tempToken() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

async function readOutputFile(
  ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>,
  outputName: string,
  context: string,
): Promise<Uint8Array> {
  try {
    return (await ffmpeg.readFile(outputName)) as Uint8Array;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${context} did not create an output file${detail ? `: ${detail}` : ""}`);
  }
}

function reencodeCutArgs(
  inputName: string,
  outputName: string,
  startSec: number,
  endSec: number,
  perf: PerfOptions,
): string[] {
  const duration = (endSec - startSec).toFixed(3);
  const args = [
    "-ss", formatSeconds(startSec),
    "-i", inputName,
    "-t", duration,
    "-map", "0:v:0",
    "-map", "0:a?",
    ...encodeArgs(perf),
    "-c:a", "aac", "-b:a", perf.lowPerf ? "96k" : "128k",
    ...threadArgs(perf),
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    "-y", outputName,
  ];
  const sf = scaleFilter(perf);
  if (sf) args.splice(args.indexOf("-c:v"), 0, "-vf", sf);
  return args;
}

function scaleFilter(perf: PerfOptions): string | null {
  const h = perf.maxHeight ?? (perf.lowPerf ? 480 : 0);
  if (!h) return null;
  // Only downscale if source is larger; keep even dims for yuv420p.
  return `scale='min(iw,trunc(oh*a/2)*2)':'min(${h},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
}

/** Fast remux of an MPEG-TS blob into an MP4 container (no re-encode). */
export async function remuxTsToMp4(
  file: File | Blob,
  onP?: ProgressCb,
): Promise<Uint8Array> {
  const ffmpeg = await getFFmpeg();
  const off = onP ? onProgress(ffmpeg, onP) : () => {};
  const token = tempToken();
  const inputName = `remux_${token}.ts`;
  const outputName = `remux_${token}.mp4`;
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  const tryExec = async (args: string[]) => {
    await ffmpeg.exec(args);
    return readOutputFile(ffmpeg, outputName, "TS remux");
  };
  try {
    // First attempt: copy both streams, apply AAC ADTS→ASC when audio is AAC.
    try {
      return await tryExec([
        "-fflags", "+genpts",
        "-i", inputName,
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        "-movflags", "+faststart",
        "-y", outputName,
      ]);
    } catch {
      // Second attempt: copy both streams without the ADTS filter (audio may
      // already be in a container-friendly form, or the container has no audio).
      try {
        return await tryExec([
          "-fflags", "+genpts",
          "-i", inputName,
          "-c", "copy",
          "-movflags", "+faststart",
          "-y", outputName,
        ]);
      } catch {
        // Last resort: video-only remux (some HLS variants ship no audio at all).
        return await tryExec([
          "-fflags", "+genpts",
          "-i", inputName,
          "-map", "0:v:0",
          "-c", "copy",
          "-movflags", "+faststart",
          "-y", outputName,
        ]);
      }
    }
  } finally {
    off();
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}


export async function cutVideo(
  file: File | Blob,
  startSec: number,
  endSec: number,
  onP?: ProgressCb,
  perf: PerfOptions = {},
): Promise<Uint8Array> {
  if (endSec <= startSec) throw new Error("End must be greater than start");
  const ffmpeg = await getFFmpeg();
  const off = onP ? onProgress(ffmpeg, onP) : () => {};
  const token = tempToken();
  const inputName = `cut_${token}.bin`;
  const outputName = `cut_${token}.mp4`;
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  const duration = (endSec - startSec).toFixed(3);
  const mustReencode = !!(perf.lowPerf || perf.maxHeight);
  try {
    if (mustReencode) throw new Error("reencode");
    // Fast copy: no CPU cost, ideal for weak hardware.
    await ffmpeg.exec([
      "-ss", formatSeconds(startSec),
      "-i", inputName,
      "-t", duration,
      "-c", "copy",
      "-movflags", "+faststart",
      "-y", outputName,
    ]);
    return await readOutputFile(ffmpeg, outputName, "Fast cut");
  } catch {
    // Re-encode fallback (keyframe-accurate)
    try { await ffmpeg.deleteFile(outputName); } catch {}
    const args = reencodeCutArgs(inputName, outputName, startSec, endSec, perf);
    await ffmpeg.exec(args);
    return await readOutputFile(ffmpeg, outputName, "Re-encoded cut");
  } finally {
    off();
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}

export async function cutAndConcat(
  file: File | Blob,
  segments: Array<{ start: number; end: number }>,
  onP?: ProgressCb,
  perf: PerfOptions = {},
): Promise<Uint8Array> {
  if (segments.length === 0) throw new Error("No segments to cut");
  for (const s of segments) {
    if (s.end <= s.start) throw new Error("End must be greater than start in every segment");
  }
  if (segments.length === 1) {
    return cutVideo(file, segments[0].start, segments[0].end, onP, perf);
  }
  const ffmpeg = await getFFmpeg();
  const off = onP ? onProgress(ffmpeg, onP) : () => {};
  const token = tempToken();
  const inputName = `concat_input_${token}.bin`;
  const listName = `concat_${token}.txt`;
  const outputName = `concat_${token}.mp4`;
  const segmentNames = segments.map((_, i) => `concat_part_${token}_${i}.mp4`);
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  try {
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      await ffmpeg.exec(reencodeCutArgs(inputName, segmentNames[i], s.start, s.end, perf));
      await readOutputFile(ffmpeg, segmentNames[i], `Segment ${i + 1}`);
    }

    await ffmpeg.writeFile(
      listName,
      new TextEncoder().encode(segmentNames.map((name) => `file '${name}'`).join("\n")),
    );

    try {
      await ffmpeg.exec([
        "-f", "concat",
        "-safe", "0",
        "-i", listName,
        "-c", "copy",
        "-movflags", "+faststart",
        "-y", outputName,
      ]);
      return await readOutputFile(ffmpeg, outputName, "Concatenation");
    } catch {
      try { await ffmpeg.deleteFile(outputName); } catch {}
      await ffmpeg.exec([
        "-f", "concat",
        "-safe", "0",
        "-i", listName,
        "-map", "0:v:0",
        "-map", "0:a?",
        ...encodeArgs(perf),
        "-c:a", "aac", "-b:a", perf.lowPerf ? "96k" : "128k",
        ...threadArgs(perf),
        "-movflags", "+faststart",
        "-y", outputName,
      ]);
      return await readOutputFile(ffmpeg, outputName, "Re-encoded concatenation");
    }
  } finally {
    off();
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(listName); } catch {}
    for (const name of segmentNames) {
      try { await ffmpeg.deleteFile(name); } catch {}
    }
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}




export async function extractAudioMp3(
  file: File | Blob,
  onP?: ProgressCb,
  perf: PerfOptions = {},
): Promise<Uint8Array> {
  const ffmpeg = await getFFmpeg();
  const off = onP ? onProgress(ffmpeg, onP) : () => {};
  const token = tempToken();
  const inputName = `audio_input_${token}.mp4`;
  const outputName = `audio_${token}.mp3`;
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  try {
    try {
      await ffmpeg.exec([
        "-i", inputName,
        "-map", "0:a:0",
        "-vn",
        "-ar", "16000", "-ac", "1",
        // On weak hardware a slightly lower quality MP3 still transcribes fine
        // and is 20-30% faster to encode.
        "-c:a", "libmp3lame", "-q:a", perf.lowPerf ? "7" : "4",
        ...threadArgs(perf),
        "-y", outputName,
      ]);
      return await readOutputFile(ffmpeg, outputName, "Audio extraction");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        detail.includes("Stream map") ||
          detail.includes("matches no streams") ||
          detail.includes("did not create an output file") ||
          /ErrnoError:\s*FS error|FS error/i.test(detail)
          ? "No usable audio track found in this clip"
          : `Audio extraction failed${detail ? `: ${detail}` : ""}`,
      );
    }
  } finally {
    off();
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}

const FONT_URL =
  "https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf";
const FONT_FAMILY = "Noto Sans";
let fontLoaded = false;

async function ensureFont(ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>) {
  if (fontLoaded) return;
  try {
    await ffmpeg.createDir("/fonts");
  } catch {
    // already exists
  }
  const bytes = await fetchFile(FONT_URL);
  await ffmpeg.writeFile("/fonts/NotoSans-Regular.ttf", bytes);
  fontLoaded = true;
}

export interface SubtitleStyle {
  /** Font size in pixels (relative to source video height in ASS PlayRes) */
  fontSize: number;
  /** Outline (black contour) thickness in pixels. 0 disables. */
  outline: number;
  /** Horizontal position of the subtitle's centre, 0..100 (% of video width). */
  xPct: number;
  /** Vertical position of the subtitle's centre, 0..100 (% of video height). */
  yPct: number;
  /** Video width in pixels (used as ASS PlayResX). */
  videoWidth: number;
  /** Video height in pixels (used as ASS PlayResY). */
  videoHeight: number;
}

function assTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

export interface AssCue { start: number; end: number; text: string; xPct?: number; yPct?: number }

export function cuesToAss(cues: AssCue[], style: SubtitleStyle): string {
  const w = Math.max(1, Math.round(style.videoWidth));
  const h = Math.max(1, Math.round(style.videoHeight));
  const outline = Math.max(0, style.outline);
  const defaultX = Math.round((style.xPct / 100) * w);
  const defaultY = Math.round((style.yPct / 100) * h);

  // Alignment=5 => middle-center anchor, so \pos(x,y) places the centre of the text at (x,y).
  const styleLine =
    `Style: Default,${FONT_FAMILY},${style.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,` +
    `1,0,0,0,100,100,0,0,1,${outline},0,5,0,0,0,1`;

  const events = cues
    .filter((c) => c.end > c.start && c.text.trim().length > 0)
    .map((c) => {
      const px = typeof c.xPct === "number" ? Math.round((c.xPct / 100) * w) : defaultX;
      const py = typeof c.yPct === "number" ? Math.round((c.yPct / 100) * h) : defaultY;
      return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,{\\pos(${px},${py})}${escapeAssText(c.text)}`;
    })
    .join("\n");

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styleLine,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    events,
    "",
  ].join("\n");
}

export async function burnSubtitles(
  video: File | Blob,
  assText: string,
  onP?: ProgressCb,
  perf: PerfOptions = {},
): Promise<Uint8Array> {
  const ffmpeg = await getFFmpeg();
  const off = onP ? onProgress(ffmpeg, onP) : () => {};
  const token = tempToken();
  const inputName = `burn_input_${token}.mp4`;
  const subsName = `subs_${token}.ass`;
  const outputName = `burned_${token}.mp4`;
  await ensureFont(ffmpeg);
  await ffmpeg.writeFile(inputName, await fetchFile(video));
  await ffmpeg.writeFile(subsName, new TextEncoder().encode(assText));
  const sf = scaleFilter(perf);
  const vf = sf
    ? `${sf},ass=${subsName}:fontsdir=/fonts`
    : `ass=${subsName}:fontsdir=/fonts`;
  try {
    await ffmpeg.exec([
      "-i", inputName,
      "-map", "0:v:0",
      "-map", "0:a?",
      "-vf", vf,
      ...encodeArgs(perf),
      "-c:a", "aac", "-b:a", perf.lowPerf ? "96k" : "128k",
      ...threadArgs(perf),
      "-movflags", "+faststart",
      "-y", outputName,
    ]);
    return await readOutputFile(ffmpeg, outputName, "Subtitle burn-in");
  } finally {
    off();
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(subsName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}

/** Read intrinsic width/height from a video File/Blob using a hidden element. */
export async function getVideoDimensions(src: File | Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(src);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const cleanup = () => URL.revokeObjectURL(url);
    v.onloadedmetadata = () => {
      const width = v.videoWidth || 1280;
      const height = v.videoHeight || 720;
      cleanup();
      resolve({ width, height });
    };
    v.onerror = () => {
      cleanup();
      reject(new Error("Could not read video metadata"));
    };
    v.src = url;
  });
}
