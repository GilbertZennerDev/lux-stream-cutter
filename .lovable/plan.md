## Root cause

The per-block preview and the final burned video differ because of **line wrapping**, not font size:

- **Preview** (`CuePreview.tsx`, `LiveSubtitleOverlay.tsx`) renders each caption inside a CSS box with `max-width: 92%` and `whitespace-pre-line`. Long cues wrap automatically onto 2–3 lines.
- **Burn-in** (`cuesToAss` in `src/lib/ffmpeg/operations.ts`) writes the ASS header with `WrapStyle: 2`, which means "no automatic wrapping — only explicit `\N` breaks the line". Long cues render as one very wide single line that spills far past what the preview showed.

Font-size scaling was already fixed last turn, so short cues already match. The remaining mismatch is 100% due to wrapping. Bold/font-family differences are negligible visually.

## Fix

Pre-wrap the cue text in JavaScript before it goes into the ASS file, using the exact same width budget the preview uses (92 % of source video width) and the same per-cue font size. Insert `\N` at the chosen break points and keep `WrapStyle: 2` so ffmpeg respects our breaks verbatim.

Steps in `src/lib/ffmpeg/operations.ts`:

1. Add a helper `wrapTextForAss(text, fontSizePx, maxWidthPx)` that:
   - Uses an offscreen `<canvas>` 2D context with font `bold ${fontSize}px "Noto Sans", sans-serif` (matches burn Bold=1 + Noto Sans and closely matches the preview's `font-semibold`).
   - Greedy word-wrap: builds lines word-by-word, starts a new line when `measureText(line + " " + word).width > maxWidthPx`.
   - Preserves any explicit `\n` the user typed as hard breaks.
   - Returns the text with `\n` between wrapped lines; the existing `escapeAssText` already converts `\n` → `\N`.

2. In `cuesToAss`, for each cue compute `maxWidthPx = Math.round(w * 0.92)` (same 92 % the preview uses) and pass the cue's effective font size (currently the shared `style.fontSize` — per-cue font override isn't in the model, so shared size is correct).

3. Guard for SSR / no-canvas: if `typeof document === "undefined"` or `getContext("2d")` returns null, fall back to a character-count heuristic (`~ maxWidthPx / (fontSize * 0.55)` chars per line) so the burn worker path stays deterministic.

4. Keep `WrapStyle: 2` (respect our explicit breaks; libass won't add its own).

No changes to the preview components — the preview is what the user is anchoring on, so we make the burn match it, not the other way around.

## Verification

- Typecheck with `tsgo --noEmit`.
- Manually: a long cue that wraps to 3 lines in the transcript-row preview should burn as the same 3 lines at the same positions in the exported MP4.

## Out of scope

- Per-cue font-size overrides (not in the data model today).
- Switching the preview font to Noto Sans WOFF (system sans is visually close enough; would add a font download to every list row).
- Changing wrap width from 92 % (matches current preview `max-width`).
