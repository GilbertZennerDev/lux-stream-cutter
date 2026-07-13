## Goal

Prove the uploaded font file's actual bytes end up on ffmpeg's virtual FS and are the ones libass renders with, by switching the burn to the explicit `FontFile=<absolute path>` form the user asked for.

Today `burnSubtitles` writes the downloaded bytes to `/fonts/<family>.<ext>` and relies on libass resolving `Fontname` via `fontsdir=/fonts`. That's indirect — if the font's internal family name doesn't match the row's `family` string, libass silently falls back to Noto Sans and the burn looks like the custom font "didn't load" even though the bytes are on disk.

Switch to passing the file path directly so there's no name-matching guesswork.

## Changes

### 1. `src/lib/ffmpeg/operations.ts`

- `ensureFont` keeps its current behaviour (download from `fonts` bucket, write to `/fonts/<sanitizedFamily>.<format>`, cache per ffmpeg instance, log byte counts). Additionally return the written absolute path so callers can pass it to libass:
  ```ts
  async function ensureFont(ffmpeg, custom?): Promise<{ fontFile?: string }>
  ```
  Returns `{ fontFile: "/fonts/<sanitized>.<ext>" }` when a custom font is installed, `{}` otherwise.

- `cuesToAss` stops embedding the family in the ASS `Style:` line for custom fonts — the `force_style` override on the ffmpeg command will win anyway. Keep Noto Sans as the in-file style so previews without a custom font stay unchanged.

- `burnSubtitles(video, assText, onP?, perf?, customFont?)`:
  - Call `const { fontFile } = await ensureFont(ffmpeg, customFont)`.
  - Build the video filter using the `subtitles=` filter (which also reads .ass) plus `force_style` when we have a `fontFile`:
    ```
    subtitles=<subsName>:fontsdir=/fonts:force_style='FontFile=<fontFile>'
    ```
    Escape the single-quoted value so ffmpeg's filtergraph parser accepts it (colons and commas inside `force_style` must be `\:` and `\,`; the path itself has neither, but the wrapper is still needed).
  - When there's no custom font, keep the current `ass=<subsName>:fontsdir=/fonts` filter so nothing regresses.
  - Keep the existing scale-filter chaining (`scaleFilter` output prepended with a comma).
  - Keep the existing `-map` avoidance note and encode args.

- Add one more log right before `ffmpeg.exec` in `burnSubtitles`: `console.log("[burnSubtitles] vf =", vf, "customFont =", customFont?.family)` so we can see in the console that the exact path we wrote is the exact path handed to ffmpeg.

### 2. `src/routes/index.tsx`

No behaviour change. Still resolves the selected dropdown value to `{ family, storagePath, format }` and passes it to `burnSubtitles`. The `cuesToAss(..., fontFamily)` third argument becomes unused for custom fonts — leave the signature as-is so the call sites don't need edits.

### 3. No DB / storage / RLS changes

The `fonts` bucket read policy from the Fonts Manager migration is enough.

## Verification

- Watch the browser console during a burn with a custom font selected:
  - `[ensureFont] downloading "<family>" from storage: <path>`
  - `[ensureFont] downloaded "<family>" (<fmt>) — <N> bytes in <ms>ms` — N should match the row's size in the DB (~27 KB for the Whitney faces).
  - `[ensureFont] wrote /fonts/<family>.<ext> to ffmpeg FS — <N> bytes` — same N, proving the bytes round-tripped.
  - `[burnSubtitles] vf = ...subtitles=...:force_style='FontFile=/fonts/<family>.<ext>' customFont = <family>` — proves the exact path is passed to ffmpeg.
- The rendered subtitles in the exported MP4 visibly use the uploaded typeface. Switching the dropdown back to "Default" and burning again renders in Noto Sans.

## Technical notes

- libass accepts `FontFile=<absolute path>` inside `force_style`; combined with `fontsdir=/fonts` it also resolves any @font-face fallbacks the file references.
- ffmpeg's `subtitles=` filter reads both .srt and .ass — our existing ASS text (with `\pos` positioning, `WrapStyle=2`, per-cue coords) is preserved.
- `force_style` values are comma-separated inside single quotes; the file path has no commas or single quotes so no extra escaping is required beyond quoting the whole value.

## Out of scope

- Live preview (`LiveSubtitleOverlay` / `CuePreview`) using the custom font — still CSS-only.
- Font weight / italic / per-cue overrides, font subsetting.
