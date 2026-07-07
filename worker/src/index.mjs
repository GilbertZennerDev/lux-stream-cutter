// LuxStream auto-recorder worker.
// Runs 24/7. Every minute it checks the schedule (Tue/Wed/Thu 14:00–18:00
// Europe/Luxembourg) and — during a session — records the Chamber TV HLS
// stream in 5-min chunks, uploading each chunk to the Lovable Cloud
// `recordings` bucket via a signed public hook.

import { isInSession, nextSessionWindow } from "./schedule.mjs";
import { startRecording } from "./recorder.mjs";
import { createRecording, markReady, markFailed, uploadToSignedUrl } from "./uploader.mjs";

const PLAYLIST_URL =
  process.env.PLAYLIST_URL ??
  "https://media02.webtvlive.eu/chd-edge/smil:chamber_tv_hd.smil/playlist.m3u8";

const CHUNK_MS = Number(process.env.CHUNK_MS ?? 5 * 60 * 1000); // 5 min
const POLL_MS = 60_000; // schedule check cadence

const log = (m) => console.log(`[worker] ${new Date().toISOString()} ${m}`);

async function uploadChunk({ buffer, startedAt, endedAt, sessionDate, chunkIndex, sourceUrl }) {
  if (buffer.length === 0) {
    log(`chunk ${chunkIndex} empty, skip`);
    return;
  }
  let created;
  try {
    created = await createRecording({
      sessionDate,
      chunkIndex,
      startedAt: startedAt.toISOString(),
      sourceUrl,
    });
  } catch (err) {
    log(`create failed for chunk ${chunkIndex}: ${err.message}`);
    return;
  }
  try {
    await uploadToSignedUrl(created.uploadUrl, buffer, "video/mp2t");
    await markReady({
      id: created.id,
      endedAt: endedAt.toISOString(),
      sizeBytes: buffer.length,
    });
    log(`chunk ${chunkIndex} uploaded (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    log(`upload failed for chunk ${chunkIndex}: ${err.message}`);
    try { await markFailed({ id: created.id, error: err.message.slice(0, 500) }); } catch {}
  }
}

async function runSession(session) {
  log(`session start · date=${session.sessionDate} until=${session.end.toISOString()}`);
  let chunkIndex = 0;
  let recorder = null;
  let chunkStart = new Date();

  const startNewChunk = async () => {
    try {
      recorder = await startRecording(PLAYLIST_URL);
      chunkStart = new Date();
      log(`chunk ${chunkIndex} recording…`);
    } catch (err) {
      log(`start chunk ${chunkIndex} failed: ${err.message}`);
      recorder = null;
    }
  };

  await startNewChunk();

  while (new Date() < session.end) {
    // wait until either chunk-rotation time or session end.
    const now = Date.now();
    const rotateAt = chunkStart.getTime() + CHUNK_MS;
    const sleepMs = Math.max(500, Math.min(rotateAt, session.end.getTime()) - now);
    await new Promise((r) => setTimeout(r, sleepMs));

    if (recorder) {
      const prev = recorder;
      const prevStart = chunkStart;
      const prevIdx = chunkIndex;
      recorder = null;

      const stillInSession = new Date() < session.end;
      chunkIndex++;
      if (stillInSession) await startNewChunk();

      // finalize previous chunk in background
      (async () => {
        try {
          const buffer = await prev.stop();
          await uploadChunk({
            buffer,
            startedAt: prevStart,
            endedAt: new Date(),
            sessionDate: session.sessionDate,
            chunkIndex: prevIdx,
            sourceUrl: PLAYLIST_URL,
          });
        } catch (err) {
          log(`finalize chunk ${prevIdx} err: ${err.message}`);
        }
      })();
    }
  }

  // session ended — flush current chunk if any
  if (recorder) {
    try {
      const buffer = await recorder.stop();
      await uploadChunk({
        buffer,
        startedAt: chunkStart,
        endedAt: new Date(),
        sessionDate: session.sessionDate,
        chunkIndex,
        sourceUrl: PLAYLIST_URL,
      });
    } catch (err) {
      log(`final chunk err: ${err.message}`);
    }
  }
  log(`session complete`);
}

async function main() {
  log(`up. Playlist=${PLAYLIST_URL} chunkMs=${CHUNK_MS}`);
  while (true) {
    try {
      const active = isInSession();
      if (active) {
        await runSession(active);
      } else {
        const next = nextSessionWindow();
        const waitMs = Math.max(POLL_MS, next.start.getTime() - Date.now());
        log(`idle · next session ${next.start.toISOString()} (in ${(waitMs / 60000).toFixed(1)} min)`);
        // Sleep in POLL_MS increments so restarts / clock drift stay responsive.
        await new Promise((r) => setTimeout(r, Math.min(waitMs, POLL_MS)));
      }
    } catch (err) {
      log(`loop error: ${err.message}`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
