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

function scaleFilter(perf: PerfOptions): string | null {
  const h = perf.maxHeight ?? (perf.lowPerf ? 480 : 0);
  if (!h) return null;
  // Only downscale if source is larger; keep even dims for yuv420p.
  return `scale='min(iw,trunc(oh*a/2)*2)':'min(${h},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
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
  const inputName = "input.bin";
  const outputName = "clip.mp4";
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  const duration = (endSec - startSec).toFixed(3);
  try {
    // Fast copy: no CPU cost, ideal for weak hardware.
    await ffmpeg.exec([
      "-ss", formatSeconds(startSec),
      "-i", inputName,
      "-t", duration,
      "-c", "copy",
      "-movflags", "+faststart",
      "-y", outputName,
    ]);
    const data = await ffmpeg.readFile(outputName);
    return data as Uint8Array;
  } catch {
    // Re-encode fallback (keyframe-accurate)
    const args = [
      "-ss", formatSeconds(startSec),
      "-i", inputName,
      "-t", duration,
      ...encodeArgs(perf),
      "-c:a", "aac", "-b:a", perf.lowPerf ? "96k" : "128k",
      ...threadArgs(perf),
      "-movflags", "+faststart",
      "-y", outputName,
    ];
    const sf = scaleFilter(perf);
    if (sf) args.splice(args.indexOf("-c:v"), 0, "-vf", sf);
    await ffmpeg.exec(args);
    const data = await ffmpeg.readFile(outputName);
    return data as Uint8Array;
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
  const inputName = "input.bin";
  const outputName = "clip.mp4";
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  try {
    const parts: string[] = [];
    const labels: string[] = [];
    segments.forEach((s, i) => {
      parts.push(`[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`);
      parts.push(`[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}]`);
      labels.push(`[v${i}][a${i}]`);
    });
    parts.push(`${labels.join("")}concat=n=${segments.length}:v=1:a=1[outv][outa]`);
    const filter = parts.join(";");
    const args = [
      "-i", inputName,
      "-filter_complex", filter,
      "-map", "[outv]",
      "-map", "[outa]",
      ...encodeArgs(perf),
      "-c:a", "aac", "-b:a", perf.lowPerf ? "96k" : "128k",
      ...threadArgs(perf),
      "-movflags", "+faststart",
      "-y", outputName,
    ];
    const sf = scaleFilter(perf);
    if (sf) {
      // Inject scale into each video trim by chaining after setpts
      const scaled = parts.map((p) =>
        p.startsWith("[0:v]trim") ? p.replace("setpts=PTS-STARTPTS", `setpts=PTS-STARTPTS,${sf}`) : p,
      );
      args[args.indexOf("-filter_complex") + 1] = scaled.join(";");
    }
    await ffmpeg.exec(args);
    const data = await ffmpeg.readFile(outputName);
    return data as Uint8Array;
  } finally {
    off();
    try { await ffmpeg.deleteFile(inputName); } catch {}
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
  const inputName = "clip.mp4";
  const outputName = "clip.mp3";
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  try {
    await ffmpeg.exec([
      "-i", inputName,
      "-vn",
      "-ar", "16000", "-ac", "1",
      // On weak hardware a slightly lower quality MP3 still transcribes fine
      // and is 20-30% faster to encode.
      "-c:a", "libmp3lame", "-q:a", perf.lowPerf ? "7" : "4",
      ...threadArgs(perf),
      "-y", outputName,
    ]);
    const data = await ffmpeg.readFile(outputName);
    return data as Uint8Array;
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

export async function burnSubtitles(
  video: File | Blob,
  srtText: string,
  fontSize: number,
  onP?: ProgressCb,
  perf: PerfOptions = {},
): Promise<Uint8Array> {
  const ffmpeg = await getFFmpeg();
  const off = onP ? onProgress(ffmpeg, onP) : () => {};
  const inputName = "clip.mp4";
  const subsName = "subs.srt";
  const outputName = "clip_subbed.mp4";
  await ensureFont(ffmpeg);
  await ffmpeg.writeFile(inputName, await fetchFile(video));
  await ffmpeg.writeFile(subsName, new TextEncoder().encode(srtText));
  const style =
    `FontName=${FONT_FAMILY},FontSize=${fontSize},PrimaryColour=&HFFFFFF&,` +
    `OutlineColour=&H000000&,BorderStyle=1,Outline=2,Shadow=0,` +
    `Bold=1,Alignment=2,MarginV=40`;
  const sf = scaleFilter(perf);
  const vf = sf
    ? `${sf},subtitles=${subsName}:fontsdir=/fonts:force_style='${style}'`
    : `subtitles=${subsName}:fontsdir=/fonts:force_style='${style}'`;
  try {
    await ffmpeg.exec([
      "-i", inputName,
      "-vf", vf,
      ...encodeArgs(perf),
      "-c:a", "copy",
      ...threadArgs(perf),
      "-movflags", "+faststart",
      "-y", outputName,
    ]);
    const data = await ffmpeg.readFile(outputName);
    return data as Uint8Array;
  } finally {
    off();
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(subsName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}
