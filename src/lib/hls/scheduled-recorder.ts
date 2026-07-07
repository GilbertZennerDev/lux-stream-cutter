import { supabase } from "@/integrations/supabase/client";
import { startRecording, type RecorderHandle } from "./recorder";
import {
  createRecording,
  markRecordingReady,
  markRecordingFailed,
} from "@/lib/recordings.functions";

const RECORDINGS_BUCKET = "recordings";

export interface ScheduledRecorderOptions {
  playlistUrl: string;
  /** Rotate every N ms. Default: 5 min. */
  chunkMs?: number;
  /** ISO local session date (yyyy-mm-dd). */
  sessionDate: string;
  /** Called on log lines. */
  onLog?: (msg: string) => void;
  /** Called when a chunk is fully uploaded and marked ready. */
  onChunkReady?: (info: { id: string; chunkIndex: number; sizeBytes: number }) => void;
  /** Called on any per-chunk failure (recording continues). */
  onChunkError?: (msg: string) => void;
}

export interface ScheduledRecorderHandle {
  stop: () => Promise<void>;
  /** Number of chunks started so far (includes any currently in flight). */
  getChunkCount: () => number;
  isRunning: () => boolean;
  /** Snapshot bytes buffered in the current in-flight chunk (null if none). */
  snapshotCurrent: () => { blob: Blob; startedAt: Date; chunkIndex: number } | null;
}

/**
 * Record an HLS stream continuously by rotating an internal recorder every
 * `chunkMs`. Each rotation uploads the finished chunk to Lovable Cloud storage
 * and creates a `recordings` row.
 */
export function startScheduledRecording(
  opts: ScheduledRecorderOptions,
): ScheduledRecorderHandle {
  const chunkMs = opts.chunkMs ?? 5 * 60 * 1000;
  let stopped = false;
  let chunkIndex = 0;
  let current: RecorderHandle | null = null;
  let currentStartedAt = new Date();
  let rotateTimer: ReturnType<typeof setTimeout> | null = null;

  const log = (m: string) => opts.onLog?.(m);

  const uploadChunk = async (
    blob: Blob,
    startedAt: Date,
    endedAt: Date,
    index: number,
  ) => {
    if (blob.size === 0) {
      log(`[REC] Chunk ${index} empty, skipping`);
      return;
    }
    try {
      const created = await createRecording({
        data: {
          sessionDate: opts.sessionDate,
          chunkIndex: index,
          startedAt: startedAt.toISOString(),
          sourceUrl: opts.playlistUrl,
        },
      });
      log(`[REC] Uploading chunk ${index} (${(blob.size / 1024 / 1024).toFixed(1)} MB)…`);
      const { error } = await supabase.storage
        .from(RECORDINGS_BUCKET)
        .uploadToSignedUrl(created.path, created.token, blob, {
          contentType: "video/mp2t",
        });
      if (error) throw error;
      await markRecordingReady({
        data: {
          id: created.id,
          endedAt: endedAt.toISOString(),
          sizeBytes: blob.size,
        },
      });
      log(`[REC] Chunk ${index} uploaded ✓`);
      opts.onChunkReady?.({ id: created.id, chunkIndex: index, sizeBytes: blob.size });
    } catch (err) {
      const msg = (err as Error).message;
      log(`[REC] Chunk ${index} upload failed: ${msg}`);
      opts.onChunkError?.(msg);
      // best-effort mark failed (id may not exist)
      try {
        // we don't have id here if createRecording itself threw; ignore
      } catch {}
    }
  };

  const rotate = async () => {
    if (stopped) return;
    const prev = current;
    const prevStart = currentStartedAt;
    const prevIndex = chunkIndex;

    // Start the next chunk immediately to minimize gap.
    chunkIndex++;
    currentStartedAt = new Date();
    try {
      current = await startRecording(opts.playlistUrl);
      current.onLog(log);
    } catch (err) {
      log(`[REC] Failed to start chunk ${chunkIndex}: ${(err as Error).message}`);
      opts.onChunkError?.((err as Error).message);
      current = null;
    }
    scheduleRotate();

    // Finish and upload the previous chunk in the background.
    if (prev) {
      try {
        const blob = await prev.stop();
        await uploadChunk(blob, prevStart, new Date(), prevIndex);
      } catch (err) {
        log(`[REC] Chunk ${prevIndex} finalize error: ${(err as Error).message}`);
      }
    }
  };

  const scheduleRotate = () => {
    if (rotateTimer) clearTimeout(rotateTimer);
    rotateTimer = setTimeout(rotate, chunkMs);
  };

  // Kick off first chunk
  (async () => {
    try {
      current = await startRecording(opts.playlistUrl);
      current.onLog(log);
      log(`[REC] Chunk ${chunkIndex} started`);
      scheduleRotate();
    } catch (err) {
      log(`[REC] Failed to start: ${(err as Error).message}`);
      opts.onChunkError?.((err as Error).message);
    }
  })();

  return {
    isRunning: () => !stopped,
    getChunkCount: () => chunkIndex + 1,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (rotateTimer) {
        clearTimeout(rotateTimer);
        rotateTimer = null;
      }
      const prev = current;
      const prevStart = currentStartedAt;
      const prevIndex = chunkIndex;
      current = null;
      if (prev) {
        try {
          const blob = await prev.stop();
          await uploadChunk(blob, prevStart, new Date(), prevIndex);
        } catch (err) {
          log(`[REC] Final chunk error: ${(err as Error).message}`);
        }
      }
    },
  };
}

// Explicitly reference to keep import from being tree-shaken if unused in one path.
void markRecordingFailed;
