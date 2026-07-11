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

const PREFIX = "cutter-session:";

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
  await del(PREFIX + sessionKey);
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
