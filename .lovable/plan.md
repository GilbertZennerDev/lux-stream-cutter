# Fix Recordings tab buttons

Audit every button on `/recordings` (row + header), reproduce each in the running preview, and fix the ones that don't behave correctly. Two are already reported broken: **Cut** and **Watch** (the Play/Preview icon).

## Buttons to verify

Per row (in `src/routes/recordings.tsx`, lines 294–344):
1. **Cut** — should open the recording in the Cutter tab with the video loaded.
2. **Transcript** (FileText icon) — opens the transcript editor dialog.
3. **Watch** (Play icon) — opens an in-page preview dialog, remuxing `.ts` → MP4 on the fly.
4. **Download** — triggers a signed-URL download.
5. **Delete** (Trash icon) — confirms then deletes the row + storage object.

Header:
6. **Upload video** — picks files and uploads them into a new session.
7. **Refresh** — re-fetches the list.

## Suspected root causes (to confirm during repro)

- **Cut** currently calls `navigate({ to: "/", search: { recording: r.id } as never })`. The `/` route reads `search.recording` in a `useEffect` and immediately calls `navigate({ to: "/", search: {}, replace: true })` in its `finally` block (index.tsx line 277). Likely bug: the URL-clearing navigation runs before/while the loader effect settles state, or the search param is dropped by the router because `openInCutter` doesn't pass `from: "/recordings"`. Fix: use a typed `navigate({ to: "/", search: { recording: r.id } })` (drop the `as never` cast so TS validates the schema), and stop stripping the search param in the finally block — instead clear the ref guard when the effect returns, so a repeat Cut on the same id still re-loads.
- **Watch** calls `previewMut.mutate(r)` which fetches the whole signed URL blob, then runs `remuxTsToMp4` in ffmpeg.wasm. For a 5–10 min chunk this is a long silent hang with no visible progress — the dialog only opens after remux completes because `setPreview({ url: "", title, remuxing: true })` renders `remuxing` but the mutation never updates the dialog if ffmpeg throws or the browser is slow to load ffmpeg-core. Likely fixes: open the dialog *before* awaiting fetch/remux (show the spinner immediately on click), surface ffmpeg progress via `onProgress`, and handle the "audio-only / no video" ffmpeg failure path by falling back to a raw `<video>` element with the signed URL (Safari can play TS natively; Chrome will show an unplayable-media error which is better than an infinite spinner).
- **Download** — likely fine, but verify the anchor click actually triggers a download (needs `document.body.appendChild(a)` in some browsers, and `a.target = "_blank"` for cross-origin signed URLs).
- **Delete / Transcript / Upload / Refresh** — verify in repro; only fix if broken.

## Repro & verification

- Drive the preview with Playwright (headless Chromium) logged in via the injected Supabase session, navigate to `/recordings`, click each button in turn, and screenshot the result + console + network. Confirm:
  - Cut → URL becomes `/`, cutter shows the recording title and video loads.
  - Watch → preview dialog opens immediately, shows a spinner, then plays the remuxed MP4 (or a clear error toast).
  - Download → a `.ts` file lands in the download list.
  - Delete → row disappears after confirm.
  - Transcript → editor dialog opens with the saved cues.
  - Upload / Refresh → header controls behave as expected.

## Out of scope

- No backend/schema changes.
- No changes to the recorder, worker, or ffmpeg-core packaging.
- No visual redesign — only wire-up fixes on the existing buttons.
