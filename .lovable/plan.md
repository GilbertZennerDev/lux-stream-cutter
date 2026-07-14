## Range-select checkbox on transcript blocks

Add a second checkbox to each transcript block that selects every cue between the last "anchor" cue and the clicked one (inclusive), with a confirmation dialog before applying.

### Behavior

- Each cue row already has a single Checkbox that toggles one cue. Keep it untouched.
- Add a **second** checkbox to the left of the existing one (distinct icon/tint, e.g. an outline with a small "range" glyph or a `ChevronsUpDown` decoration, plus `aria-label="Select range up to block N"` and a tooltip "Select range from last anchor").
- Track an anchor: the last cue whose range-checkbox was clicked (`rangeAnchor: number | null`). If no anchor exists yet, use the lowest currently-selected cue index; if none selected, the first cue.
- On click:
  1. Compute `[min(anchor, clicked), max(anchor, clicked)]`.
  2. Find all cue indices in that inclusive range that are **not already selected**.
  3. If that set is empty (single-cue range or all already selected), just set anchor = clicked and add clicked to selection — no dialog.
  4. Otherwise open an AlertDialog: "Select N blocks from #A to #B?" with Cancel / Confirm.
  5. On Confirm: add all indices in the range to `selectedCues`, set anchor = clicked.
- The range checkbox visual state shows "checked" when the cue index is the current anchor, otherwise unchecked — it's an action trigger, not a persistent toggle. (Alternative: always show unchecked; using anchor highlight is clearer.)
- Clearing selection (existing Clear button) also clears the anchor.

### Files to edit

- `src/routes/index.tsx`
  - Add `rangeAnchor` state + `setRangeAnchor` next to `selectedCues`.
  - Add local state `rangePending: { from: number; to: number; toAdd: number[] } | null` for the confirmation dialog.
  - Add handler `onRangeCheck(clickedIdx)` implementing the logic above.
  - In the cue row (line ~1815), insert the new Checkbox before the existing one.
  - Reset anchor in the Clear button handler and in `setSelectedCues(new Set(...))` on session load.
  - Render an `AlertDialog` (already available in `components/ui/alert-dialog`) near the cue list with Confirm/Cancel wired to `rangePending`.

### Not in scope

- No change to the existing single-toggle checkbox behavior.
- No keyboard shift-click shortcut (can be a follow-up if wanted).
- No backend/session-schema change (anchor is UI-only, not persisted).
