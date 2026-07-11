
# Make subtitle positioning actually usable

## Problems today (confirmed in `src/routes/index.tsx` ~L1506–1620)

1. The big live preview at the top writes to global `subX / subY`. The per-cue block below uses `xPct / yPct` overrides on that cue. They are **two disconnected controls** — moving the top one does nothing to the list, which is confusing.
2. The per-cue preview is `SubtitlePreview` — an abstract grey 16:9 box with a fake sample string. It doesn't show the real frame, so you're positioning blind against actual footage.
3. The per-cue preview is tiny (fits in a list row) and there's no way to expand it for careful placement.
4. Dragging is free 2D. Users often only want to nudge vertically (subtitle bar) or only horizontally (keep at a fixed lower-third height). No axis lock.

## The solution (one coherent flow)

### A. Per-cue previews show a real video frame at that cue's timestamp
- New component `CuePreview` that renders a `<canvas>` snapshot of the source video sampled at `(cue.start + cue.end) / 2` (mid-cue is more representative than start).
- Snapshot generated once via a hidden `<video>` + `canvas.drawImage`, cached in a `Map<cueIndex, dataUrl>` keyed by `sessionKey + cue.index + roundedMidTime`. Cheap, no ffmpeg, works offline, ~50 KB per frame.
- Regenerates only when the cue's time window changes or the source video changes. Not on every text edit.
- The subtitle text and current position (`xPct/yPct` or fallback) are overlaid on the snapshot using the same scaling logic as `LiveSubtitleOverlay` — WYSIWYG.

Why snapshot vs live `<video>`: a real `<video>` per cue would spawn 20–100 decoders, kill Safari, and thrash memory. A snapshot is enough because positioning is spatial, not temporal.

### B. Bigger editor on demand — "Open editor" dialog
- Each cue row gets an **Edit position** button (icon: `Maximize2`). Opens a shadcn `Dialog` with:
  - Large (up to 900 px wide, `aspect-video`) live snapshot with draggable overlay for that specific cue.
  - X / Y sliders, axis-lock toggle (see C), reset button, "Apply to all following cues" and "Apply to all cues" shortcuts (huge time-saver: users usually place once and want the rest to follow).
  - Live preview of the actual cue text (multi-line, respects `\n`).
- The tiny inline preview stays for quick nudges; the dialog is for precision.

### C. Axis lock — restrict movement to X or Y
- A three-state segmented toggle in both the inline row (when selected) and the big dialog:
  ```
  [ Free ] [ Horizontal only ] [ Vertical only ]
  ```
- State lives per-session (`lockAxis: "free" | "x" | "y"`), persisted via `saveCutterSession`.
- Drag handler in `LiveSubtitleOverlay` + new `CuePreview` reads `lockAxis` and clamps the unchanged coordinate to the previous value. Sliders for the locked axis are disabled and greyed with a small lock icon so it's obvious why.

### D. Unify the two positioners — main preview writes to the "current" cue
- The top `LiveSubtitleOverlay` already highlights the active cue during playback. Extend the same behavior to dragging:
  - If a cue is active at the current time, dragging the overlay updates **that cue's** `xPct/yPct` (per-cue override), not the global default.
  - If no cue is active (or before playback), it updates the global default `subX/subY` (current behavior).
  - Small chip in the corner of the top overlay reads either `Default position` or `Cue #12 position` so the user always knows what they're editing. Click the chip to flip modes explicitly.
- This is the fix for demand #1 without breaking the "set global default" workflow — one control, context-aware.

### E. Housekeeping to make it feel finished
- The per-cue chip `pos 42,88` becomes a proper `Badge` with a tiny reset (×) button — one-click revert.
- Keyboard: with the big dialog open, arrow keys nudge 1 %, shift+arrow nudges 5 %. Axis lock still applies.
- The current tiny `SubtitlePreview` in each row is replaced by `CuePreview` (real frame) at ~2× its current height (`h-32` → readable but still list-friendly). Users who want more open the dialog.

## Behaviour when the user does nothing

- No opt-in required. Snapshots are lazy — only cues actually rendered in the visible `ScrollArea` compute one (use `IntersectionObserver`). Off-screen cues never grab a frame.
- Existing sessions keep their `xPct/yPct` overrides. `lockAxis` defaults to `"free"`. Global `subX/subY` still work as fallback.

## Files touched

- **new** `src/components/cutter/CuePreview.tsx` — snapshot canvas + overlay + drag with `lockAxis`. Accepts `videoSrc`, `time`, `xPct`, `yPct`, `text`, `fontSize`, `outline`, `lockAxis`, `onChange`, `size` ("inline" | "large").
- **new** `src/components/cutter/CuePositionDialog.tsx` — shadcn `Dialog` wrapping a large `CuePreview` + sliders + axis lock + "apply to following / all" actions + keyboard nudges.
- **new** `src/lib/cutter/frameSnapshots.ts` — shared cache: `getFrameAt(videoSrc, timeSec): Promise<string>`, with an LRU (~60 entries) and cleanup on `sessionKey` change.
- **edit** `src/components/cutter/LiveSubtitleOverlay.tsx` — accept optional `lockAxis` and a `mode: "default" | "cue"` indicator; add the corner chip; when a cue is active, route `onChange` to the parent's per-cue setter instead of the global one.
- **edit** `src/routes/index.tsx`:
  - Add `lockAxis` state + persist through `cutterSession`.
  - Replace inline `SubtitlePreview` in the per-cue block with `CuePreview` (inline size).
  - Add the "Edit position" button opening `CuePositionDialog`.
  - Wire the top `LiveSubtitleOverlay` change handler to per-cue vs global based on active cue.
- **edit** `src/lib/session/cutterSession.ts` — add `lockAxis` to `CutterSessionState`.

No changes to ffmpeg, worker, LuxASR, Recordings, Premiere, Studio, or the pipeline itself.

## Explicitly not doing

- No per-cue live `<video>` (perf).
- No new dependency (canvas snapshotting is native).
- No redesign of the transcript list layout beyond swapping the preview component and adding the "Edit position" button.
- No changes to the SRT / ASS output logic — same `xPct/yPct` fields feed `cuesToAss` as today.

## Open question (1)

For demand #4 ("restrict either the width or the height"), I read this as "lock one drag axis so I don't accidentally shift the subtitle sideways when I only want to change its vertical position" — the axis-lock toggle above. If you actually meant "constrain the subtitle text box width/height (max line width, max lines)", say the word and I'll add a `maxWidthPct` per-cue control instead / in addition.
