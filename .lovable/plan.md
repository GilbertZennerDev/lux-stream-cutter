
## Problem

"Cut selected" produces an MP4 with **no** burned subtitles. The transcript-list previews and the LiveSubtitleOverlay still show captions correctly (they use CSS `@font-face`). Only the final burned clip is empty.

The burn path (`src/lib/ffmpeg/operations.ts → burnSubtitles`) hasn't visibly changed since the font-upload work, but two things it depends on have:

1. `ensureFont` now writes the font as `/fonts/<sanitized-family>.<ext>` instead of the fixed `NotoSans-Regular.ttf`. When no upload is selected, this writes `/fonts/Noto_Sans.ttf` — a filename libass has never seen before.
2. `cuesToAss` now writes the real internal family into the ASS `Style: Default,<Fontname>,…` line. If that family isn't discoverable inside `fontsdir=/fonts` at burn time, libass falls back — and in ffmpeg.wasm libass builds without a system font config, that fallback is often "nothing rendered" rather than the built-in Noto Sans.

Net effect: every burn — even with the default font — now depends on libass successfully matching a font by internal name inside `/fonts`, and that match is fragile. Symptom lines up with "no subtitles at all".

## Fix

Make font discovery robust so libass always finds a usable face, and add just enough logging that if it ever fails again the ffmpeg log tells us exactly why.

### Changes in `src/lib/ffmpeg/operations.ts`

1. **Always install the Noto Sans fallback** in `ensureFont`, in addition to any override.
   - Track Noto Sans separately from the override family. On every `ensureFont` call, if Noto Sans hasn't been written to `/fonts/NotoSans-Regular.ttf` yet, write it. Then, if `override` is set and its family hasn't been written, write it too.
   - This restores the previous behaviour where `/fonts` always contained Noto Sans, and adds custom fonts alongside it.

2. **Use an explicit ASS filter form** in `burnSubtitles`:
   - `-vf "…,subtitles=filename=subs_xxx.ass:fontsdir=/fonts:force_style='FontName=<family>'"` (still using `subtitles` filter which handles both SRT and ASS, with `filename=` explicit so no positional-parsing surprises).
   - `force_style` re-asserts the Fontname at filter time so it doesn't matter whether libass parsed the ASS header font entry correctly.

3. **Sanity-check the ASS text before running** — throw with a clear message when `cuesToAss` produced zero `Dialogue:` lines. Right now an empty events section silently produces an empty burn; a clear error would have caught this class of issue earlier.

4. **Attach ffmpeg log capture around the burn exec** so the existing `appendLog` panel in the Cutter shows libass's "Font 'X' not found, using default" lines. `onFfmpegLog` in `src/lib/ffmpeg/client.ts` already exposes a listener — wire it up scoped to the burn call and restore the previous listener when done.

### Verification

- With no custom font selected, run "Cut selected" on 2 blocks — burned MP4 must show white captions in Noto Sans.
- With a custom TTF selected (real family differs from filename), run "Cut selected" — burned MP4 must show captions in the custom font.
- Delete the healed row's family in devtools to a wrong string and re-burn — captions must still appear (in Noto Sans fallback) because `force_style` + always-installed Noto Sans covers the miss.
- Cancel mid-burn, then re-run — the WeakMap reset means Noto Sans is re-installed on the fresh ffmpeg instance.

### Out of scope

- Changing how fonts are uploaded / stored / healed. Upload path stays as-is.
- Server-side burn.

## Files touched

- `src/lib/ffmpeg/operations.ts` — always-install Noto Sans, `subtitles=…:force_style=…` filter, empty-cues guard, scoped ffmpeg log capture.
- (No changes to `FontPicker.tsx`, `fonts.functions.ts`, `useFonts.ts`, `routes/index.tsx` schema, or DB.)
