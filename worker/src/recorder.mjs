import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function fetchBytes(url, signal) {
  const res = await fetch(url, { signal, headers: { "User-Agent": "LuxStreamWorker/1.0" } });
  if (!res.ok) throw new Error(`Segment fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

async function muxAvIntoTs(videoBuffer, audioBuffer) {
  const dir = await mkdtemp(join(tmpdir(), "luxstream-mux-"));
  const videoPath = join(dir, "video.ts");
  const audioPath = join(dir, "audio.ts");
  const outputPath = join(dir, "output.ts");
  try {
    await writeFile(videoPath, videoBuffer);
    await writeFile(audioPath, audioBuffer);
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
      await execFileAsync("ffmpeg", args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
    } catch (err) {
      const stderr = err.stderr ? `: ${String(err.stderr).slice(-1000)}` : "";
      throw new Error(`audio mux failed${stderr}`);
    }
    const muxed = await readFile(outputPath);
    const streams = await probeBufferStreams(muxed, "muxed output");
    if (!streams.hasVideo) throw new Error("audio mux failed: muxed output has no video stream");
    if (!streams.hasAudio) throw new Error("audio mux failed: muxed output has no audio stream");
    return muxed;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function probeBufferStreams(buffer, label) {
  const dir = await mkdtemp(join(tmpdir(), "luxstream-probe-"));
  const inputPath = join(dir, "input.ts");
  try {
    await writeFile(inputPath, buffer);
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Start recording an HLS playlist. Returns a handle:
 *   { stop() -> Promise<Buffer>, snapshotFrom(startIdx) -> {buffer,endIdx}, getSegmentCount() }
 * Captures split HLS audio renditions in parallel and muxes them into the TS.
 */
export async function startRecording(playlistUrl) {
  const videoChunks = [];
  const audioChunks = [];
  const seenVideo = new Set();
  const seenAudio = new Set();
  const ac = new AbortController();
  let stopped = false;
  let bytes = 0;
  let audioBytes = 0;
  let audioRequired = false;
  let lastOutputInfo = null;

  const first = await fetchText(playlistUrl, ac.signal);
  let mediaUrl = playlistUrl;
  let audioUrl;
  if (isMasterPlaylist(first)) {
    const variants = parseMaster(first, playlistUrl);
    if (!variants.length) throw new Error("Master playlist has no variants");
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
        log(`audio group ${chosen.audioGroup} (${match.name || "unnamed"}) detected: ${audioUrl}`);
      } else {
        log(`audio group ${chosen.audioGroup} declared but no URI found`);
      }
    } else {
      log("no separate audio group declared; assuming muxed media playlist");
    }
  } else {
    log("media playlist detected directly; separate audio rendition cannot be discovered");
  }

  const pollLoop = async (url, seen, sink, tag, countBytes) => {
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
            const buf = await fetchBytes(segUrl, ac.signal);
            sink.push(buf);
            if (countBytes) bytes += buf.byteLength;
            else audioBytes += buf.byteLength;
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

  pollLoop(mediaUrl, seenVideo, videoChunks, "video", true)
    .catch((err) => { if (!stopped) log(`video crash: ${err.message}`); });
  if (audioUrl) {
    pollLoop(audioUrl, seenAudio, audioChunks, "audio", false)
      .catch((err) => { if (!stopped) log(`audio crash: ${err.message}`); });
  }

  const buildBufferFrom = async (startIdx) => {
    const video = Buffer.concat(videoChunks.slice(startIdx));
    if (video.length === 0) throw new Error("no video segments were captured");

    if (!audioRequired) {
      const streams = await probeBufferStreams(video, "captured output");
      if (!streams.hasVideo) throw new Error("captured output has no video stream");
      lastOutputInfo = {
        expected: false,
        videoSegments: videoChunks.length - startIdx,
        videoBytes: video.length,
        capturedSegments: 0,
        capturedBytes: 0,
        outputHasAudio: streams.hasAudio,
        streams: streams.summary,
      };
      log(`captured output streams: ${streams.summary}`);
      return video;
    }

    if (!audioUrl) throw new Error("audio expected but no audio rendition URI was available");
    if (audioChunks.length === 0) throw new Error("audio expected but no audio segments were captured");
    const audioStartIdx = Math.min(startIdx, audioChunks.length);
    const audio = Buffer.concat(audioChunks.slice(audioStartIdx));
    if (audio.length === 0) throw new Error("audio expected but audio slice was empty");
    const muxed = await muxAvIntoTs(video, audio);
    const streams = await probeBufferStreams(muxed, "verified muxed output");
    if (!streams.hasAudio) throw new Error(`audio expected but verified output has no audio stream (${streams.summary})`);
    lastOutputInfo = {
      expected: true,
      videoSegments: videoChunks.length - startIdx,
      videoBytes: video.length,
      capturedSegments: audioChunks.length - audioStartIdx,
      capturedBytes: audio.length,
      outputHasAudio: true,
      streams: streams.summary,
    };
    log(`muxed ${lastOutputInfo.videoSegments} video segments (${(video.length / 1024 / 1024).toFixed(1)} MB) with ${lastOutputInfo.capturedSegments} audio segments (${(audio.length / 1024 / 1024).toFixed(1)} MB); output streams: ${streams.summary}; muxed ${(muxed.length / 1024 / 1024).toFixed(1)} MB`);
    return muxed;
  };

  return {
    getSegmentCount: () => videoChunks.length,
    getAudioSegmentCount: () => audioChunks.length,
    getBytes: () => bytes,
    getAudioBytes: () => audioBytes,
    getAudioVerification: () => lastOutputInfo,
    stop: async () => {
      stopped = true;
      ac.abort();
      return buildBufferFrom(0);
    },
    snapshotFrom: async (startIdx) => {
      const buf = await buildBufferFrom(startIdx);
      return { buffer: buf, endIdx: videoChunks.length };
    },
  };
}
