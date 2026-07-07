import { startRecording, type RecorderHandle } from "./recorder";

/**
 * Background HLS recorder shared across routes. Once started, it survives
 * client-side navigation between Studio, Cutter, etc. Callers can take
 * incremental snapshots ("since last snapshot") without stopping the stream.
 */

const URL_STORAGE_KEY = "luxstream:sharedStreamUrl";
export const DEFAULT_STREAM_URL =
  "https://media02.webtvlive.eu/chd-edge/smil:chamber_tv_hd.smil/playlist.m3u8";

interface Shared {
  url: string;
  handle: RecorderHandle;
  startedAt: Date;
  cursor: number; // video-segment index of last snapshot
  logs: string[];
}

let shared: Shared | null = null;
let starting: Promise<Shared> | null = null;

export function getSharedStreamUrl(): string {
  if (typeof window === "undefined") return DEFAULT_STREAM_URL;
  return window.localStorage.getItem(URL_STORAGE_KEY) || DEFAULT_STREAM_URL;
}

export function setSharedStreamUrl(url: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(URL_STORAGE_KEY, url);
}

export function isSharedRecorderRunning(): boolean {
  return shared !== null;
}

export function getSharedRecorderInfo(): {
  url: string;
  startedAt: Date;
  cursor: number;
  bufferedSegments: number;
} | null {
  if (!shared) return null;
  return {
    url: shared.url,
    startedAt: shared.startedAt,
    cursor: shared.cursor,
    bufferedSegments: shared.handle.getVideoSegmentCount(),
  };
}

/** Start (or reuse) the shared recorder for `url`. If a recorder is already
 *  running for a different URL, it is stopped and replaced. */
export async function ensureSharedRecorder(
  url: string,
  onLog?: (msg: string) => void,
): Promise<Shared> {
  if (shared && shared.url === url) return shared;
  if (starting) return starting;
  starting = (async () => {
    if (shared) {
      try {
        await shared.handle.stop();
      } catch {}
      shared = null;
    }
    const handle = await startRecording(url);
    const logs: string[] = [];
    handle.onLog((m) => {
      logs.push(m);
      if (logs.length > 200) logs.shift();
      onLog?.(m);
    });
    shared = { url, handle, startedAt: new Date(), cursor: 0, logs };
    setSharedStreamUrl(url);
    return shared;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** Return the delta blob since the last snapshot (or since start) and advance
 *  the cursor so the next call only sees new bytes. */
export async function snapshotSharedRecorderDelta(): Promise<
  { blob: Blob; startedAt: Date; endedAt: Date; segments: number } | null
> {
  if (!shared) return null;
  const startCursor = shared.cursor;
  const { blob, endIdx } = await shared.handle.snapshotFrom(startCursor);
  const startedAt = shared.startedAt;
  const endedAt = new Date();
  shared.cursor = endIdx;
  shared.startedAt = endedAt; // next snapshot's "start" is now
  return { blob, startedAt, endedAt, segments: endIdx - startCursor };
}

export async function stopSharedRecorder(): Promise<void> {
  if (!shared) return;
  const s = shared;
  shared = null;
  try {
    await s.handle.stop();
  } catch {}
}
