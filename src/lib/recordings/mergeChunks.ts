/**
 * Merge multiple recording chunks (typically 5-minute Chamber TV slices)
 * into one continuous file the user can send straight to the Cutter.
 *
 * MPEG-TS (.ts) is designed to be binary-concatenatable — that's the
 * common case for scheduled recordings and it's O(n) with no re-encode.
 * Falls back to ffmpeg-based concat when the mix isn't uniform.
 */
import { getRecordingDownloadUrl, type RecordingRow } from "@/lib/recordings.functions";
import type { SrtCue } from "@/lib/subtitles/luxasrToSrt";

export interface MergeResult {
  file: File;
  cues?: SrtCue[];
  title: string;
}

export type MergeProgress = (label: string, done: number, total: number) => void;

function extOf(row: RecordingRow): string {
  const p = row.storage_path.toLowerCase();
  const m = /\.([a-z0-9]+)$/.exec(p);
  return m?.[1] ?? "bin";
}

/** Rows already sorted by (session_date, chunk_index). */
export async function mergeRecordings(
  rows: RecordingRow[],
  onProgress?: MergeProgress,
): Promise<MergeResult> {
  if (rows.length === 0) throw new Error("Select at least one recording");
  const ordered = [...rows].sort((a, b) => {
    if (a.session_date !== b.session_date) return a.session_date < b.session_date ? -1 : 1;
    return a.chunk_index - b.chunk_index;
  });

  const exts = new Set(ordered.map(extOf));
  if (exts.size !== 1) {
    throw new Error(
      `Selected chunks have mixed formats (${[...exts].join(", ")}). Merge only chunks of the same type.`,
    );
  }
  const ext = [...exts][0];
  const isTs = ext === "ts" || ext === "m2ts";
  const mime = isTs ? "video/mp2t" : ext === "mp4" || ext === "m4v" ? "video/mp4" : `video/${ext}`;

  const parts: Blob[] = [];
  const totalSteps = ordered.length + 1;
  // Track chunk durations so we can shift each chunk's transcript timestamps
  // into the merged timeline. Duration comes from ended_at/started_at when
  // present, else falls back to probing the blob.
  const chunkDurations: number[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i];
    onProgress?.(`Downloading chunk #${r.chunk_index}`, i, totalSteps);
    const { url } = await getRecordingDownloadUrl({ data: { id: r.id } });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch chunk #${r.chunk_index}: ${res.status}`);
    const blob = await res.blob();
    parts.push(blob);
    let duration = 0;
    if (r.started_at && r.ended_at) {
      duration = (new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000;
    }
    if (!duration || duration <= 0) {
      // Fall back to the last cue's end when available.
      const last = r.transcript?.[r.transcript.length - 1];
      if (last?.end) duration = last.end + 1;
    }
    chunkDurations.push(duration > 0 ? duration : 0);
  }

  if (!isTs && ordered.length > 1) {
    // For non-TS we'd need proper ffmpeg concat. The Chamber pipeline is
    // TS-only so this is a rare edge case; surface it clearly.
    throw new Error("Merging non-TS chunks is not supported yet. Merge only .ts chunks or work on a single chunk.");
  }

  onProgress?.("Assembling merged file", ordered.length, totalSteps);
  const merged = new Blob(parts, { type: mime });
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const title = `Merged · ${first.session_date} · chunks ${first.chunk_index}–${last.chunk_index}`;
  const fileName = `merged_${first.session_date}_${first.chunk_index}-${last.chunk_index}.${ext}`;
  const file = new File([merged], fileName, { type: mime, lastModified: Date.now() });

  // Merge transcripts with cumulative time offsets, only if EVERY chunk has one.
  let cues: SrtCue[] | undefined;
  if (ordered.every((r) => r.transcript && r.transcript.length > 0)) {
    const out: SrtCue[] = [];
    let offset = 0;
    let idx = 1;
    for (let i = 0; i < ordered.length; i++) {
      const r = ordered[i];
      for (const c of r.transcript ?? []) {
        out.push({
          index: idx++,
          start: c.start + offset,
          end: c.end + offset,
          text: c.text,
        });
      }
      offset += chunkDurations[i] || 0;
    }
    cues = out;
  }

  return { file, cues, title };
}
