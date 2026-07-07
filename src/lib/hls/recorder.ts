import { isMasterPlaylist, parseMaster, parseMedia, parseAudioMedia } from "./parsePlaylist";

export interface RecorderStatus {
  segments: number;
  bytes: number;
  elapsedMs: number;
  lastError?: string;
}

export interface RecorderHandle {
  stop: () => Promise<Blob>;
  /** Snapshot currently buffered bytes as an MPEG-TS blob without stopping. */
  snapshot: () => Promise<Blob>;
  /**
   * Snapshot video/audio segments starting at `startIdx` (video segment index)
   * up to the current end. Returns the delta blob and the new cursor to pass
   * back next time to get only newly-buffered bytes.
   */
  snapshotFrom: (startIdx: number) => Promise<{ blob: Blob; endIdx: number }>;
  /** Current number of buffered video segments (usable as a cursor). */
  getVideoSegmentCount: () => number;
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

/** Concatenate a buffer list into a single Blob with the given MIME. */
function concatBlob(parts: Uint8Array[], type: string): Blob {
  return new Blob(parts.map((u) => u as BlobPart), { type });
}

/**
 * Mux a video-only MPEG-TS blob with an audio blob (usually AAC-ADTS or an
 * audio-only MPEG-TS) into a single MPEG-TS blob using ffmpeg.wasm.
 * Falls back to the video-only blob if muxing fails.
 */
async function muxAvIntoTs(
  videoBlob: Blob,
  audioBlob: Blob,
  logFail: (m: string) => void,
): Promise<Blob> {
  try {
    const { getFFmpeg } = await import("../ffmpeg/client");
    const { fetchFile } = await import("@ffmpeg/util");
    const ffmpeg = await getFFmpeg();
    const vName = `mux_v_${Date.now()}.ts`;
    const aName = `mux_a_${Date.now()}.bin`;
    const oName = `mux_o_${Date.now()}.ts`;
    await ffmpeg.writeFile(vName, await fetchFile(videoBlob));
    await ffmpeg.writeFile(aName, await fetchFile(audioBlob));
    try {
      await ffmpeg.exec([
        "-fflags", "+genpts",
        "-i", vName,
        "-i", aName,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c", "copy",
        "-f", "mpegts",
        "-y", oName,
      ]);
      const data = (await ffmpeg.readFile(oName)) as Uint8Array;
      return new Blob([data as BlobPart], { type: "video/mp2t" });
    } finally {
      try { await ffmpeg.deleteFile(vName); } catch {}
      try { await ffmpeg.deleteFile(aName); } catch {}
      try { await ffmpeg.deleteFile(oName); } catch {}
    }
  } catch (err) {
    logFail(`mux failed: ${(err as Error).message}`);
    return videoBlob;
  }
}

export async function startRecording(playlistUrl: string): Promise<RecorderHandle> {
  const videoChunks: Uint8Array[] = [];
  const audioChunks: Uint8Array[] = [];
  const seenVideo = new Set<string>();
  const seenAudio = new Set<string>();
  const startedAt = Date.now();
  const ac = new AbortController();
  let stopped = false;
  let bytes = 0;
  let statusCb: ((s: RecorderStatus) => void) | null = null;
  let logCb: ((msg: string) => void) | null = null;
  let lastError: string | undefined;

  const log = (m: string) => logCb?.(m);
  const emit = () => statusCb?.({
    segments: videoChunks.length,
    bytes,
    elapsedMs: Date.now() - startedAt,
    lastError,
  });

  // Resolve variant (media) playlist URL + optional separate audio playlist.
  const firstText = await fetchText(playlistUrl, ac.signal);
  let mediaUrl = playlistUrl;
  let audioUrl: string | undefined;
  if (isMasterPlaylist(firstText)) {
    const variants = parseMaster(firstText, playlistUrl);
    if (variants.length === 0) throw new Error("Master playlist has no variants");
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const chosen = variants[0];
    mediaUrl = chosen.url;
    log(`[HLS] Variant selected: ${chosen.resolution ?? "?"} @ ${(chosen.bandwidth / 1000).toFixed(0)} kbps`);
    if (chosen.audioGroup) {
      const audios = parseAudioMedia(firstText, playlistUrl);
      const match =
        audios.find((a) => a.groupId === chosen.audioGroup && a.isDefault && a.url) ??
        audios.find((a) => a.groupId === chosen.audioGroup && a.url);
      if (match?.url) {
        audioUrl = match.url;
        log(`[HLS] Separate audio group "${chosen.audioGroup}" (${match.name}) detected — recording in parallel`);
      } else {
        log(`[HLS] Audio group "${chosen.audioGroup}" declared but no URI found — recording video only`);
      }
    }
  } else {
    log("[HLS] Media playlist detected directly");
  }

  const pollLoop = async (
    url: string,
    seen: Set<string>,
    sink: Uint8Array[],
    tag: string,
    countBytes: boolean,
  ) => {
    let interval = 2000;
    while (!stopped) {
      try {
        const text = await fetchText(url, ac.signal);
        const media = parseMedia(text, url);
        interval = Math.max(1000, Math.min(10000, (media.targetDuration || 6) * 500));
        for (const segUrl of media.segments) {
          if (stopped) break;
          if (seen.has(segUrl)) continue;
          seen.add(segUrl);
          try {
            const bytesArr = await fetchBytes(segUrl, ac.signal);
            sink.push(bytesArr);
            if (countBytes) {
              bytes += bytesArr.byteLength;
              emit();
            }
          } catch (err) {
            if (stopped) break;
            lastError = (err as Error).message;
            log(`[HLS ${tag}] Segment error: ${lastError}`);
            if (countBytes) emit();
          }
        }
        if (media.endList) {
          log(`[HLS ${tag}] End of stream reached`);
          stopped = true;
          break;
        }
      } catch (err) {
        if (stopped) break;
        lastError = (err as Error).message;
        log(`[HLS ${tag}] Playlist error: ${lastError}`);
        if (countBytes) emit();
      }
      for (let i = 0; i < interval && !stopped; i += 200) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  };

  pollLoop(mediaUrl, seenVideo, videoChunks, "V", true).catch((err) => {
    if (!stopped) log(`[HLS V] Recorder crashed: ${(err as Error).message}`);
  });
  if (audioUrl) {
    pollLoop(audioUrl, seenAudio, audioChunks, "A", false).catch((err) => {
      if (!stopped) log(`[HLS A] Recorder crashed: ${(err as Error).message}`);
    });
  }

  const buildBlobFrom = async (startIdx: number): Promise<Blob> => {
    const vSlice = videoChunks.slice(startIdx);
    const video = concatBlob(vSlice, "video/mp2t");
    if (!audioUrl || audioChunks.length === 0) return video;
    // Take the same proportional slice of the audio buffer. Audio and video
    // segments are usually aligned 1:1 in HLS; if they drift, ffmpeg will
    // realign timestamps at mux time.
    const aSlice = audioChunks.slice(Math.min(startIdx, audioChunks.length));
    const isAac = /\.aac(\?|$)/i.test(audioUrl);
    const audio = concatBlob(aSlice, isAac ? "audio/aac" : "video/mp2t");
    return muxAvIntoTs(video, audio, (m) => log(`[HLS] ${m}`));
  };

  return {
    onStatus: (cb) => { statusCb = cb; },
    onLog: (cb) => { logCb = cb; },
    snapshot: () => buildBlobFrom(0),
    snapshotFrom: async (startIdx: number) => {
      const endIdx = videoChunks.length;
      const blob = await buildBlobFrom(startIdx);
      return { blob, endIdx };
    },
    getVideoSegmentCount: () => videoChunks.length,
    stop: async () => {
      stopped = true;
      ac.abort();
      return buildBlobFrom(0);
    },
  };
}
