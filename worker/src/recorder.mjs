import { isMasterPlaylist, parseMaster, parseMedia } from "./parsePlaylist.mjs";

const log = (msg) => console.log(`[rec] ${msg}`);

async function fetchText(url, signal) {
  const res = await fetch(url, { signal, headers: { "User-Agent": "LuxStreamWorker/1.0" } });
  if (!res.ok) throw new Error(`Playlist fetch ${res.status}`);
  return res.text();
}

async function fetchBytes(url, signal) {
  const res = await fetch(url, { signal, headers: { "User-Agent": "LuxStreamWorker/1.0" } });
  if (!res.ok) throw new Error(`Segment fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

/**
 * Start recording an HLS playlist. Returns a handle:
 *   { stop() -> Promise<Buffer>, snapshotFrom(startIdx) -> {buffer,endIdx}, getSegmentCount() }
 * Video-only capture (works for Chamber TV where audio is muxed into MPEG-TS).
 */
export async function startRecording(playlistUrl) {
  const chunks = [];
  const seen = new Set();
  const ac = new AbortController();
  let stopped = false;
  let bytes = 0;

  const first = await fetchText(playlistUrl, ac.signal);
  let mediaUrl = playlistUrl;
  if (isMasterPlaylist(first)) {
    const variants = parseMaster(first, playlistUrl);
    if (!variants.length) throw new Error("Master playlist has no variants");
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    mediaUrl = variants[0].url;
    log(`variant ${variants[0].resolution ?? "?"} @ ${(variants[0].bandwidth / 1000).toFixed(0)} kbps`);
  }

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
            const buf = await fetchBytes(segUrl, ac.signal);
            chunks.push(buf);
            bytes += buf.byteLength;
          } catch (err) {
            if (stopped) break;
            log(`segment err: ${err.message}`);
          }
        }
        if (media.endList) { stopped = true; break; }
      } catch (err) {
        if (stopped) break;
        log(`playlist err: ${err.message}`);
      }
      for (let i = 0; i < interval && !stopped; i += 200) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  })().catch((err) => { if (!stopped) log(`crash: ${err.message}`); });

  return {
    getSegmentCount: () => chunks.length,
    getBytes: () => bytes,
    stop: async () => {
      stopped = true;
      ac.abort();
      return Buffer.concat(chunks);
    },
    snapshotFrom: (startIdx) => {
      const buf = Buffer.concat(chunks.slice(startIdx));
      return { buffer: buf, endIdx: chunks.length };
    },
  };
}
