## Goal

Hide rarely-needed UI on the Cutter route so the default view is: **source video with live subtitles + transcript list**. Anything power-users touch occasionally becomes a click-to-expand.

## Changes (all in `src/routes/index.tsx`)

### 1. Collapse the "Log" card
Replace the always-open Log card (~lines 2269-2284) with a `Collapsible`:
- Trigger row: "Log" title + chevron + a tiny status hint (e.g. `12 lines` or `No logs yet`), plus a subtle red dot when the most recent line starts with `[ERROR]` so failures still surface.
- Auto-open once when a new `[ERROR]` line is appended (via `useEffect` on `logs`), so users don't miss failures.
- Body = existing `ScrollArea` unchanged.

### 2. Collapse the full-video controls under "Subtitle look"
Under the big `LiveSubtitleOverlay` (~lines 1819-1869), everything below the overlay — Lock-axis toggle, X slider, Y slider, Outline slider — moves into a `Collapsible` labeled **"Fine-tune default position & outline"** (closed by default).
- Keep **Font size** slider visible above the overlay (users change this often; it affects readability of the live overlay itself).
- Keep the compact status line `x 50% · y 88% · outline 2px` visible next to the collapsible trigger so current values are always readable at a glance.
- Rationale: 99% of positioning now happens per-cue in the transcript list or via drag on the overlay itself; the sliders are backup.

### 3. Small polish
- Rename the header hint under the overlay to one short sentence ("Drag the caption on the frame. Per-cue tweaks live in the transcript list below.") — drop the bilingual duplicate.
- No behavior/state changes; all existing state hooks (`lockAxis`, `subX`, `subY`, `subOutline`, `logs`) stay intact so downstream code and session-restore keep working.

### 4. Not touched
- Transcript list rows, per-cue editor dialog, Advanced card, Run buttons, pipeline stepper, SRT preview — all remain as-is.
- No renaming of state, no changes to burn-in or export logic.

## Technical notes
- Reuse `Collapsible` / `CollapsibleTrigger` / `CollapsibleContent` (already imported at line 28).
- Add two local `useState<boolean>` flags: `logOpen`, `posControlsOpen`, both default `false`.
- Error auto-open: `useEffect(() => { if (logs.at(-1)?.startsWith("[ERROR]")) setLogOpen(true); }, [logs])`.
- No new dependencies. Typecheck with `tsgo --noEmit` after the edit.
