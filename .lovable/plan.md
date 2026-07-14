Make the "Cut selected" button sticky and prominent inside the transcript card.

### Current state
- The button sits in a header row above the transcript list, next to "Select all / Clear" and the selected count. It is small (`size="sm"`) and shares visual weight with nearby secondary actions.

### Proposed change
1. **Sticky bottom action bar** inside the transcript card that appears once `cues.length > 0`. It stays visible at the bottom of the transcript area while the user scrolls the cue list, so the primary action is always reachable.
2. **Prominent primary button** in the bar: larger size, filled primary style, and a clear label showing the selected count and estimated output duration (e.g., "Cut selected (3) → 0:42").
3. **Keep the header tidy** for lightweight selection controls only (select all, clear, selected count). The "Cut selected" button moves out of the header entirely.
4. **Add estimated output length** derived from the currently selected cues, so users see the result length before they click.
5. **Preserve existing states**: disabled when no file is loaded, running, or no cues selected; spinner text stays the same during cutting.

### Implementation
- Edit `src/routes/index.tsx` only.
- Add a small computed helper for the selected duration.
- Replace the header button with a sticky bottom action bar using the existing `CardContent` / `ScrollArea` structure.
- No new dependencies or backend changes.

### Not in scope
- Full layout overhaul from the larger plan (will be handled separately if asked).
- Keyboard shortcuts or undo (separate items in the plan).