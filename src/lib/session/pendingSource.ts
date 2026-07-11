/**
 * In-memory hand-off of a prepared source Blob (and optional preloaded
 * transcript cues) from one route to another — typically Recordings →
 * Cutter after a "Merge & Cut" bulk action.
 *
 * We can't stuff a File/Blob into a URL search param, so we key the payload
 * by a short UUID that the destination route reads from `?pending=<id>`.
 */
import type { SrtCue } from "@/lib/subtitles/luxasrToSrt";

export interface PendingSource {
  file: File;
  title: string;
  cues?: SrtCue[]; // merged transcript with timestamps already offset
}

const store = new Map<string, PendingSource>();

export function setPendingSource(payload: PendingSource): string {
  const id = crypto.randomUUID();
  store.set(id, payload);
  // Auto-expire after 10 minutes to avoid memory leaks if the user never
  // completes the navigation.
  setTimeout(() => store.delete(id), 10 * 60 * 1000);
  return id;
}

export function takePendingSource(id: string): PendingSource | null {
  const p = store.get(id);
  if (p) store.delete(id);
  return p ?? null;
}
