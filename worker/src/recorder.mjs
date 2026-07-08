import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isMasterPlaylist, parseMaster, parseMedia, parseAudioMedia } from "./parsePlaylist.mjs";

const execFileAsync = promisify(execFile);

const log = (msg) => console.log(`[rec] ${msg}`);

async function fetchText(url, signal) {
  const res = await fetch(url, { signal, headers: { "User-Agent": "LuxStreamWorker/1.0" } });
  if (!res.ok) throw new Error(`Playlist fetch ${res.status}`);
  return res.text();
}

async function fetchToStream(url, signal, writeStream) {
  const res = await fetch(url, { signal, headers: { "User-Agent": "LuxStreamWorker/1.0" } });
  if (!res.ok) throw new Error(`Segment fetch ${res.status}`);
  // Stream response body directly to disk; never buffer full segment in RAM.
  const reader = res.body.getReader();
  let n = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (!writeStream.write(value)) {
      await new Promise((r) => writeStream.once("drain", r));
    }
  }
  return n;
}

async function muxAvIntoTs(videoPath, audioPath, outputPath) {
  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-fflags", "+genpts",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c", "copy",
    "-f", "mpegts",
    "-y", outputPath,
  ];
  try {
    await execFileAsync("ffmpeg", args, { timeout: 180_000, maxBuffer: 1024 * 1024 });
  } catch (err) {
    const stderr = err.stderr ? `: ${String(err.stderr).slice(-1000)}` : "";
    throw new Error(`audio mux failed${stderr}`);
  }
}

async function probePathStreams(inputPath, label) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "stream=codec_type,codec_name",
        "-of", "json",
        inputPath,
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    ));
  } catch (err) {
    const stderr = err.stderr ? `: ${String(err.stderr).slice(-1000)}` : "";
    throw new Error(`ffprobe failed for ${label}${stderr}`);
  }
  const parsed = JSON.parse(stdout || "{}");
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const hasVideo = streams.some((s) => s.codec_type === "video");
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  const summary = streams.map((s) => `${s.codec_type}:${s.codec_name ?? "?"}`).join(", ") || "none";
  return { hasVideo, hasAudio, summary };
}

/**
 * Start recording an HLS playlist. Segments are appended directly to files on
 * disk so RAM stays flat regardless of chunk length. Returns a handle:
 *   stop() -> { path, sizeBytes, cleanup, videoSegments, audioSegments, audioInfo }
 */
export async function startRecording(playlistUrl) {
  const dir = await mkdtemp(join(tmpdir(), "luxstream-rec-"));
  const videoPath = join(dir, "video.ts");
  const audioPath = join(dir, "audio.ts");
  const outputPath = join(dir, "output.ts");

  const videoStream = createWriteStream(videoPath);
  const audioStream = createWriteStream(audioPath);

  const seenVideo = new Set();
  const seenAudio = new Set();
  const ac = new AbortController();
  let stopped = false;
  let videoBytes = 0;
  let audioBytes = 0;
  let videoSegments = 0;
  let audioSegments = 0;
  let audioRequired = false;
  let audioUrl;
  let mediaUrl = playlistUrl;

  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  const first = await fetchText(playlistUrl, ac.signal);
  if (isMasterPlaylist(first)) {
    const variants = parseMaster(first, playlistUrl);
    if (!variants.length) { await cleanup(); throw new Error("Master playlist has no variants"); }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const chosen = variants[0];
    mediaUrl = chosen.url;
    log(`variant ${chosen.resolution ?? "?"} @ ${(chosen.bandwidth / 1000).toFixed(0)} kbps`);
    if (chosen.audioGroup) {
      audioRequired = true;
      const audios = parseAudioMedia(first, playlistUrl);
      const match =
        audios.find((a) => a.groupId === chosen.audioGroup && a.isDefault && a.url) ??
        audios.find((a) => a.groupId === chosen.audioGroup && a.url);
      if (match?.url) {
        audioUrl = match.url;
        log(`audio group ${chosen.audioGroup} (${match.name || "unnamed"}) detected`);
      } else {
        log(`audio group ${chosen.audioGroup} declared but no URI found`);
      }
    } else {
      log("no separate audio group declared; assuming muxed media playlist");
    }
  } else {
    log("media playlist detected directly");
  }

  const pollLoop = async (url, seen, writeStream, tag, isVideo) => {
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
            const n = await fetchToStream(segUrl, ac.signal, writeStream);
            if (isVideo) { videoBytes += n; videoSegments++; }
            else { audioBytes += n; audioSegments++; }
          } catch (err) {
            if (stopped) break;
            log(`${tag} segment err: ${err.message}`);
          }
        }
        if (media.endList) { stopped = true; break; }
      } catch (err) {
        if (stopped) break;
        log(`${tag} playlist err: ${err.message}`);
      }
      for (let i = 0; i < interval && !stopped; i += 200) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  };

  pollLoop(mediaUrl, seenVideo, videoStream, "video", true)
    .catch((err) => { if (!stopped) log(`video crash: ${err.message}`); });
  if (audioUrl) {
    pollLoop(audioUrl, seenAudio, audioStream, "audio", false)
      .catch((err) => { if (!stopped) log(`audio crash: ${err.message}`); });
  }

  const closeStream = (s) => new Promise((res) => s.end(res));

  return {
    getSegmentCount: () => videoSegments,
    getAudioSegmentCount: () => audioSegments,
    getBytes: () => videoBytes,
    getAudioBytes: () => audioBytes,
    stop: async () => {
      stopped = true;
      ac.abort();
      await closeStream(videoStream);
      await closeStream(audioStream);

      if (videoBytes === 0) {
        await cleanup();
        throw new Error("no video segments were captured");
      }

      if (!audioRequired) {
        const streams = await probePathStreams(videoPath, "captured output");
        if (!streams.hasVideo) { await cleanup(); throw new Error("captured output has no video stream"); }
        const st = await stat(videoPath);
        const audioInfo = {
          expected: false,
          videoSegments,
          videoBytes,
          capturedSegments: 0,
          capturedBytes: 0,
          outputHasAudio: streams.hasAudio,
          streams: streams.summary,
        };
        log(`captured output streams: ${streams.summary} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
        return { path: videoPath, sizeBytes: st.size, cleanup, videoSegments, audioSegments, audioInfo };
      }

      if (!audioUrl) { await cleanup(); throw new Error("audio expected but no audio rendition URI was available"); }
      if (audioBytes === 0) { await cleanup(); throw new Error("audio expected but no audio segments were captured"); }

      await muxAvIntoTs(videoPath, audioPath, outputPath);
      const streams = await probePathStreams(outputPath, "verified muxed output");
      if (!streams.hasAudio) { await cleanup(); throw new Error(`audio expected but verified output has no audio stream (${streams.summary})`); }
      const st = await stat(outputPath);
      const audioInfo = {
        expected: true,
        videoSegments,
        videoBytes,
        capturedSegments: audioSegments,
        capturedBytes: audioBytes,
        outputHasAudio: true,
        streams: streams.summary,
      };
      log(`muxed ${videoSegments} video (${(videoBytes / 1024 / 1024).toFixed(1)} MB) + ${audioSegments} audio (${(audioBytes / 1024 / 1024).toFixed(1)} MB) -> ${(st.size / 1024 / 1024).toFixed(1)} MB · ${streams.summary}`);
      return { path: outputPath, sizeBytes: st.size, cleanup, videoSegments, audioSegments, audioInfo };
    },
  };
}

// Kept for backward-compat with old callers that read a whole file.
export async function readAll(path) {
  return readFile(path);
}
// Silence unused-import lint on writeFile in some tooling.
void writeFile;
