import { isMasterPlaylist, parseMaster, parseMedia } from "./parsePlaylist";

export interface RecorderStatus {
  segments: number;
  bytes: number;
  elapsedMs: number;
  lastError?: string;
}

export interface RecorderHandle {
  stop: () => Promise<Blob>;
  onStatus: (cb: (s: RecorderStatus) => void) => void;
  onLog: (cb: (msg: string) => void) => void;
}

/** Route a URL through the server-side CORS/HLS proxy. */
function viaProxy(url: string): string {
  return `/api/hls-proxy?url=${encodeURIComponent(url)}`;
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(viaProxy(url), { signal });
  if (!res.ok) throw new Error(`Playlist fetch ${res.status}`);
  return res.text();
}

async function fetchBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(viaProxy(url), { signal });
  if (!res.ok) throw new Error(`Segment fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

export async function startRecording(playlistUrl: string): Promise<RecorderHandle> {
  const chunks: Uint8Array[] = [];
  const seen = new Set<string>();
  const startedAt = Date.now();
  const ac = new AbortController();
  let stopped = false;
  let bytes = 0;
  let statusCb: ((s: RecorderStatus) => void) | null = null;
  let logCb: ((msg: string) => void) | null = null;
  let lastError: string | undefined;

  const log = (m: string) => logCb?.(m);
  const emit = () => statusCb?.({
    segments: chunks.length,
    bytes,
    elapsedMs: Date.now() - startedAt,
    lastError,
  });

  // Resolve variant (media) playlist URL.
  const firstText = await fetchText(playlistUrl, ac.signal);
  let mediaUrl = playlistUrl;
  if (isMasterPlaylist(firstText)) {
    const variants = parseMaster(firstText, playlistUrl);
    if (variants.length === 0) throw new Error("Master playlist has no variants");
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    mediaUrl = variants[0].url;
    log(`[HLS] Variant selected: ${variants[0].resolution ?? "?"} @ ${(variants[0].bandwidth / 1000).toFixed(0)} kbps`);
  } else {
    log("[HLS] Media playlist detected directly");
  }

  // Poll loop
  (async () => {
    let interval = 2000;
    while (!stopped) {
      try {
        const text = await fetchText(mediaUrl, ac.signal);
        const media = parseMedia(text, mediaUrl);
        interval = Math.max(1000, Math.min(10000, (media.targetDuration || 6) * 500));
        for (const segUrl of media.segments) {
          if (stopped) break;
          if (seen.has(segUrl)) continue;
          seen.add(segUrl);
          try {
            const bytesArr = await fetchBytes(segUrl, ac.signal);
            chunks.push(bytesArr);
            bytes += bytesArr.byteLength;
            emit();
          } catch (err) {
            if (stopped) break;
            lastError = (err as Error).message;
            log(`[HLS] Segment error: ${lastError}`);
            emit();
          }
        }
        if (media.endList) {
          log("[HLS] End of stream reached");
          stopped = true;
          break;
        }
      } catch (err) {
        if (stopped) break;
        lastError = (err as Error).message;
        log(`[HLS] Playlist error: ${lastError}`);
        emit();
      }
      // Wait before next poll
      for (let i = 0; i < interval && !stopped; i += 200) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  })().catch((err) => {
    if (!stopped) log(`[HLS] Recorder crashed: ${(err as Error).message}`);
  });

  return {
    onStatus: (cb) => { statusCb = cb; },
    onLog: (cb) => { logCb = cb; },
    stop: async () => {
      stopped = true;
      ac.abort();
      // Assemble MPEG-TS blob
      const parts: BlobPart[] = chunks.map((u) => u as BlobPart);
      return new Blob(parts, { type: "video/mp2t" });
    },
  };
}
