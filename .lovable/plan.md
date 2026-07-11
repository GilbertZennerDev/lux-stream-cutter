
# 3 quality-of-life upgrades users will actually feel

Scope: Cutter (`/`), Recordings (`/recordings`), Premiere (`/premiere`). Studio explicitly excluded.

I looked at the current UX and picked three friction points that hurt on every real session — not cosmetic polish. Each one is designed to be immediately noticeable the first time the user opens the tab.

---

## 1. Live subtitle preview on the real video (Cutter)

**Today:** `SubtitlePreview` shows a fake black 16:9 box with the placeholder text "Beispill Ennertitlen". You drag it there, then have to imagine how it will look over the actual footage. Font size, outline, and vertical position are all guesswork until you burn a full clip.

**Change:** Overlay the subtitle directly on the existing source video player.
- The overlay shows the cue whose timestamp matches `currentTime` (falls back to placeholder if none).
- Drag anywhere on the video to reposition — updates `subX/subY` live.
- Font size / outline sliders update the overlay in real time on the real frame.
- Per-cue position overrides (already stored on `SrtCue.xPct/yPct`) are shown when that cue is playing.
- Keep the abstract box available as a fallback for when no source is loaded.

**Why users notice:** the first time they scrub the video and see their captions land on top of the actual speaker's chest, they'll get it. No more "burn → download → oh, too low → try again" loop.

---

## 2. Auto-save & restore Cutter session

**Today:** A page refresh, an accidental tab close, or navigating to Recordings and back wipes: loaded file reference, transcript, cue selections, per-cue subtitle positions, sub position/size/outline, audio offset, perf settings, cut segments. All the slow work (transcription especially) is gone.

**Change:** Persist working state to IndexedDB, keyed by recording id (or a `local-<hash>` for uploaded files).
- Persist: `rawCues`, `cues`, `selectedCues`, `subX/subY/fontSize/subOutline`, `maxSentences/maxChars`, `audioOffsetSec`, `segments`, `mode`, per-cue position overrides.
- For recordings from the library: reload transparently when the same `?recording=<id>` opens.
- For local file uploads: show a subtle banner "Restore your last session from <filename> (<time ago>)? [Restore] [Discard]" — we can't reattach the File object, but the transcript + settings alone save 5–10 min.
- Add a "Reset session" button in the header of the Cutter card, and auto-clear when the pipeline completes with `mode === "full"`.

**Why users notice:** the first accidental refresh they survive without losing 30 cues of hand-edited transcript positions will make them love the app.

---

## 3. Recordings: multi-select, search, and "Merge & Cut"

**Today:** Each 5-minute chunk is its own row with individual buttons. To work on a 20-minute segment spanning 4 chunks you have to download each, stitch them manually, and re-upload. There's no filter, so scrolling past weeks of sessions is painful.

**Change:**
- **Search bar** at the top: filters by title, date, or transcript text (transcript is already stored on the row).
- **Row checkboxes** + a sticky action bar when >0 selected: `Cut merged`, `Download all`, `Delete`.
- **Cut merged**: client-side concatenates the selected `.ts`/`.mp4` chunks (using existing `cutAndConcat` with full ranges), then routes to `/` with the merged blob in memory (via a shared session store) so the Cutter opens with the stitched clip ready. Preserves merged transcript (concatenated with correctly shifted timestamps) if all selected chunks have transcripts.
- **"Select whole session" chip** on each session card header.

**Why users notice:** the Chamber TV workflow *is* multi-chunk. This turns a 15-minute manual chore into two clicks.

---

## Technical notes

- New files:
  - `src/lib/session/cutterSession.ts` — IndexedDB (via `idb-keyval`) get/set/clear for cutter state; add `bun add idb-keyval`.
  - `src/components/cutter/LiveSubtitleOverlay.tsx` — wraps the source `<video>`, renders the active cue, handles pointer-drag → `onChange(x,y)`.
  - `src/lib/recordings/mergeChunks.ts` — orders selected rows by `session_date` + `chunk_index`, downloads via existing signed URLs, calls `cutAndConcat` with each chunk's full range, returns a single `Blob` + merged transcript.
  - `src/lib/session/pendingSource.ts` — in-memory (module-scope Map) hand-off of a Blob + optional cues from Recordings to Cutter, keyed by a UUID passed in `?pending=<id>` search param.
- Edits:
  - `src/routes/index.tsx`: replace `SubtitlePreview` inside the video-preview area with `LiveSubtitleOverlay` when a `sourcePreviewUrl` exists (keep `SubtitlePreview` when no source); add auto-save `useEffect`s and restore-banner UI; read `?pending=<id>` and hydrate `file` from `pendingSource`.
  - `src/routes/recordings.tsx`: add `search` state + filter, row `Checkbox`, sticky bulk-action bar, `Cut merged` handler that builds the blob + stores it via `pendingSource.set()` then `navigate({ to: "/", search: { pending } })`.
  - Extend `indexSearchSchema` in `src/routes/index.tsx` with `pending: z.string().uuid().optional()`.
- No backend/DB changes. No new secrets. No changes to Studio, worker, or ffmpeg operations themselves — this is UI + state persistence + a small merge helper.

---

## What I'm NOT doing (kept out on purpose)

- No redesign of the header, colors, or typography — the goal is workflow wins, not repaint.
- No Studio changes.
- No new backend features, migrations, or edge functions.
- No changes to LuxASR, ffmpeg pipeline, or lip-sync — those stay untouched.
