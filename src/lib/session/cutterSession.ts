/**
 * Persist the Cutter's working state to IndexedDB so that an accidental
 * refresh / tab-close / navigation doesn't wipe hours of manual work
 * (transcript edits, per-cue subtitle positions, cue selections, sub
 * position/size/outline, audio offset, segment ranges, …).
 *
 * State is keyed by "session key":
 *   - `rec:<recordingId>` when the source came from the Recordings library
 *   - `file:<name>:<size>:<lastModified>` for locally picked files
 * so multiple in-flight projects don't stomp each other.
 */
import { get, set, del, keys } from "idb-keyval";
import type { SrtCue } from "@/lib/subtitles/luxasrToSrt";

export interface CutterSessionState {
  version: 1;
  savedAt: number;
  fileName?: string;
  fileSize?: number;
  rawCues: SrtCue[];
  cues: SrtCue[];
  selectedCues: number[];
  mode: "full" | "cut-only" | "subs-only";
  segments: Array<{ start: string; end: string }>;
  subX: number;
  subY: number;
  fontSize: number;
  subOutline: number;
  maxSentences: number;
  maxChars: number;
  audioOffsetSec: number;
  burnIn: boolean;
}

interface CachedBlob {
  version: 1;
  savedAt: number;
  blob: Blob;
  fileName: string;
  mime: string;
  lastModified: number;
}

const PREFIX = "cutter-session:";
const BLOB_PREFIX = "cutter-blob:";
/** Cap cached source videos to avoid unbounded IndexedDB growth. */
const MAX_CACHED_BLOBS = 5;

export function makeRecordingKey(id: string): string {
  return `rec:${id}`;
}
export function makeFileKey(file: { name: string; size: number; lastModified: number }): string {
  return `file:${file.name}:${file.size}:${file.lastModified}`;
}

export async function saveCutterSession(sessionKey: string, state: Omit<CutterSessionState, "version" | "savedAt">): Promise<void> {
  const payload: CutterSessionState = { ...state, version: 1, savedAt: Date.now() };
  await set(PREFIX + sessionKey, payload);
}

export async function loadCutterSession(sessionKey: string): Promise<CutterSessionState | null> {
  const v = await get<CutterSessionState>(PREFIX + sessionKey);
  return v ?? null;
}

export async function clearCutterSession(sessionKey: string): Promise<void> {
  await Promise.all([del(PREFIX + sessionKey), del(BLOB_PREFIX + sessionKey)]);
}

/** List saved local-file sessions (not recording-backed), newest first. */
export async function listLocalFileSessions(): Promise<CutterSessionState[]> {
  const allKeys = (await keys()) as string[];
  const localKeys = allKeys.filter((k) => typeof k === "string" && k.startsWith(PREFIX + "file:"));
  const out: CutterSessionState[] = [];
  for (const k of localKeys) {
    const v = await get<CutterSessionState>(k);
    if (v) out.push(v);
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out;
}

/**
 * Cache the raw source video Blob so a refresh doesn't force a re-download
 * (recordings from Storage are often 100+ MB and take ~30s over slow links).
 */
export async function saveCutterBlob(
  sessionKey: string,
  file: { name: string; type: string; lastModified: number },
  blob: Blob,
): Promise<void> {
  const payload: CachedBlob = {
    version: 1,
    savedAt: Date.now(),
    blob,
    fileName: file.name,
    mime: file.type || blob.type || "application/octet-stream",
    lastModified: file.lastModified,
  };
  await set(BLOB_PREFIX + sessionKey, payload);
  await pruneCachedBlobs();
}

export async function loadCutterBlob(sessionKey: string): Promise<File | null> {
  const v = await get<CachedBlob>(BLOB_PREFIX + sessionKey);
  if (!v) return null;
  // Refresh the LRU timestamp so recently-accessed blobs survive pruning.
  v.savedAt = Date.now();
  await set(BLOB_PREFIX + sessionKey, v).catch(() => {});
  return new File([v.blob], v.fileName, { type: v.mime, lastModified: v.lastModified });
}

export async function hasCutterBlob(sessionKey: string): Promise<boolean> {
  return (await get<CachedBlob>(BLOB_PREFIX + sessionKey)) != null;
}

async function pruneCachedBlobs(): Promise<void> {
  const allKeys = (await keys()) as string[];
  const blobKeys = allKeys.filter((k) => typeof k === "string" && k.startsWith(BLOB_PREFIX));
  if (blobKeys.length <= MAX_CACHED_BLOBS) return;
  const entries = await Promise.all(
    blobKeys.map(async (k) => ({ k, v: await get<CachedBlob>(k) })),
  );
  entries.sort((a, b) => (b.v?.savedAt ?? 0) - (a.v?.savedAt ?? 0));
  const toDelete = entries.slice(MAX_CACHED_BLOBS);
  await Promise.all(toDelete.map((e) => del(e.k)));
}

