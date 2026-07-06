import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, onProgress, type ProgressCb } from "./client";
import { formatSeconds } from "../subtitles/parseTime";

export async function cutVideo(
  file: File | Blob,
  startSec: number,
  endSec: number,
  onP?: ProgressCb,
): Promise<Uint8Array> {
  if (endSec <= startSec) throw new Error("End must be greater than start");
  const ffmpeg = await getFFmpeg();
  const off = onP ? onProgress(ffmpeg, onP) : () => {};
  const inputName = "input.bin";
  const outputName = "clip.mp4";
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  const duration = (endSec - startSec).toFixed(3);
  try {
    // Try fast copy first
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
    await ffmpeg.exec([
      "-ss", formatSeconds(startSec),
      "-i", inputName,
      "-t", duration,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
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

export async function extractAudioMp3(
  file: File | Blob,
  onP?: ProgressCb,
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
      "-c:a", "libmp3lame", "-q:a", "4",
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
  try {
    await ffmpeg.exec([
      "-i", inputName,
      "-vf", `subtitles=${subsName}:fontsdir=/fonts:force_style='${style}'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
      "-c:a", "copy",
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
