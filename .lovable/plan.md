## Plan: make custom uploaded fonts burn reliably

1. **Make the burn path use the exact selected font file**
   - Keep using the uploaded `.otf` / `.ttf` file by writing it into ffmpeg’s virtual `/fonts` directory.
   - Stop relying on the UI display name alone, because the preview can use `@font-face` while libass/ffmpeg matches the font by internal metadata.

2. **Fix libass font matching for Whitney-style fonts**
   - Parse the uploaded font’s internal names (`preferredFamily`, `fontFamily`, `fullName`, `postScriptName`, subfamily variants).
   - Generate a small ordered list of likely libass font names, including the UI family and exact internal names.
   - Rewrite the ASS `Style: Default,...` font name for each candidate before trying a burn.

3. **Add a real font visibility probe before final export**
   - Before burning the full clip, render a tiny test frame with one visible subtitle using each candidate.
   - Inspect ffmpeg/libass logs for successful font selection vs fallback.
   - Use the first candidate that libass actually resolves to the uploaded font; only fall back to Noto Sans if no uploaded candidate resolves.

4. **Improve escaping and logs so failures are actionable**
   - Harden ASS `Fontname`, `fontsdir`, and filter option escaping for spaces, hyphens, quotes, colons, and commas.
   - Add log lines like `[FONT] Trying Whitney Book`, `[FONT] Matched Whitney-Book.otf`, or `[FONT] Falling back to Noto Sans` so the Cutter log panel shows what happened.

5. **Apply the fix to both export paths**
   - Full pipeline burn-in.
   - `Cut selected` burn-in with remapped 0-based cues.

6. **Validate after implementation**
   - Run a focused TypeScript check.
   - Verify generated ASS contains non-empty `Dialogue:` lines and selected font candidates.
   - Confirm the custom-font burn path no longer silently creates subtitle-less output and still works with built-in Noto Sans.