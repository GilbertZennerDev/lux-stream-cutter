import { FFmpeg } from "@ffmpeg/ffmpeg";
import wasmAsset from "../../../public/ffmpeg/ffmpeg-core.wasm.asset.json";

// Single-threaded core hosted locally (JS) + CDN (wasm) to avoid CORS/blob
// issues with unpkg in sandboxed previews.
const CORE_URL = "/ffmpeg/ffmpeg-core.js";
const WASM_URL = wasmAsset.url;

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
      coreURL: CORE_URL,
      wasmURL: WASM_URL,
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
