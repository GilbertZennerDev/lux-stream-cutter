import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

// Single-threaded core — works without SharedArrayBuffer / COOP-COEP headers.
const CORE_VERSION = "0.12.6";
const BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

let ffmpegPromise: Promise<FFmpeg> | null = null;
let logListener: ((msg: string) => void) | null = null;

export function onFfmpegLog(cb: (msg: string) => void) {
  logListener = cb;
}

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      logListener?.(message);
    });
    await ffmpeg.load({
      coreURL: await toBlobURL(`${BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${BASE}/ffmpeg-core.wasm`, "application/wasm"),
    });
    return ffmpeg;
  })();
  return ffmpegPromise;
}

export type ProgressCb = (ratio: number) => void;

export function onProgress(ffmpeg: FFmpeg, cb: ProgressCb) {
  const handler = ({ progress }: { progress: number }) => {
    cb(Math.max(0, Math.min(1, progress)));
  };
  ffmpeg.on("progress", handler);
  return () => ffmpeg.off("progress", handler);
}
