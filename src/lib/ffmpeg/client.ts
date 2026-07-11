import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";

// Import ffmpeg-core only as emitted asset URLs. This keeps Vite from trying
// to transform ffmpeg-core.js as app source and avoids external CDN/CORS fetches.

let ffmpegPromise: Promise<FFmpeg> | null = null;
const logListeners = new Set<(msg: string) => void>();

/** Subscribe to ffmpeg log lines. Returns an unsubscribe function. */
export function onFfmpegLog(cb: (msg: string) => void): () => void {
  logListeners.add(cb);
  return () => { logListeners.delete(cb); };
}


export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      for (const cb of logListeners) cb(message);
    });

    try {
      await ffmpeg.load({ coreURL, wasmURL });
      return ffmpeg;
    } catch (error) {
      ffmpeg.terminate();
      ffmpegPromise = null;
      throw error;
    }
  })();
  return ffmpegPromise;
}

/** Hard-abort any in-flight ffmpeg work. Next getFFmpeg() call will reload. */
export async function cancelFFmpeg(): Promise<void> {
  const p = ffmpegPromise;
  ffmpegPromise = null;
  if (!p) return;
  try {
    const ff = await p;
    ff.terminate();
  } catch {
    // ignore
  }
}

export type ProgressCb = (ratio: number) => void;

export function onProgress(ffmpeg: FFmpeg, cb: ProgressCb) {
  const handler = ({ progress }: { progress: number }) => {
    cb(Math.max(0, Math.min(1, progress)));
  };
  ffmpeg.on("progress", handler);
  return () => ffmpeg.off("progress", handler);
}
