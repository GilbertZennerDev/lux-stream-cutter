## Problem

The uploaded font shows correctly in the transcript list previews (they use CSS `@font-face`) but is missing from the LiveSubtitleOverlay/burned MP4. Root cause: the ASS `Style: Default,<Fontname>,...` line uses the family name we **derived from the filename** (e.g. `"MyBrand-Regular"`), but libass inside ffmpeg matches by the font file's **internal** family name in its `name` table (e.g. `"MyBrand"`). When they don't match, libass silently falls back to Noto Sans and the burn has no visible font change. The lower "preview video" is just the burned MP4 played back, so it inherits the same fallback.

Why CSS worked: `@font-face { font-family: "X" }` is an author-declared alias — the browser uses whatever string we typed, regardless of the file's internals. libass does not.

## Fix

Make the font's **internal family name** the single source of truth used by DB, CSS `@font-face`, ASS `Fontname`, and the ffmpeg `/fonts` filename.

### Steps

1. **Parse the real family name at upload time (client-side)**
   - Add `opentype.js` (`bun add opentype.js`; ~200 KB, tree-shakes to what we need). Load it lazily only when the user uploads a font so it doesn't hit the initial bundle.
   - In `FontPicker.onFile`, after size/extension checks:
     - `opentype.parse(await file.arrayBuffer())`
     - Take `font.names.fontFamily.en` (fall back to `preferredFamily`, then to the sanitized filename stem as today).
     - For `.woff` / `.woff2`, opentype.js can't parse compressed WOFF directly — in that case, fall back to the filename-derived family and show a small warning toast ("Prefer .ttf / .otf so the burn matches the preview"). Most users upload TTF/OTF.
   - Pass this real family into `createFontUpload({ family })` — the server function already accepts it.

2. **Persist and expose the real family**
   - No schema change. The existing `fonts.family` column now stores the real internal family.
   - `useFonts` continues to inject `@font-face { font-family: "<real family>"; src: url(...) }` — CSS previews keep working.
   - The ffmpeg pipeline gets the same string via `fontOverride.family`, so ASS `Fontname` and the file written to `/fonts/<family>.<ext>` both match what libass sees inside the font file.

3. **Match ffmpeg `/fonts` filename to real family**
   - `ensureFont` already writes `/fonts/<sanitized family>.<ext>`. Because libass scans by internal family (not filename) this is only cosmetic — but keeping it aligned makes debugging easier.
   - Keep the WeakMap cache per ffmpeg instance so switching fonts mid-session still works.

4. **Migrate existing rows lazily**
   - Any font uploaded before this fix keeps its filename-derived family in the DB. When the user selects such a font in the picker, we can't retroactively rewrite it without re-parsing. Add a one-time "Re-detect family" path: on selection, if the picker sees the font hasn't been verified, fetch the file from its signed URL, parse it, and if the real family differs, update the row via a new server fn `updateFontFamily({ id, family })` (auth: uploader only). This keeps old uploads usable without asking the user to re-upload.
   - Alternative if that feels heavy: just tell the user to re-upload once. I'll go with the auto-redetect path since it's a one-liner call and prevents the same confusion again.

5. **Verify**
   - Upload a TTF whose internal family differs from its filename (any Google Font renamed on disk works). Confirm: picker label shows the real family; LiveSubtitleOverlay renders in that font; the burned MP4 played back in the lower preview and downloaded also renders in that font.
   - Upload a WOFF2: picker warns and falls back to filename family; burn still uses the same string so at least CSS + burn stay consistent (burn will fall back to Noto Sans in libass, which is unavoidable without a TTF/OTF).
   - Legacy row: pick a pre-fix font once → row gets rewritten with the real family → next burn works.

## Files touched

- `package.json` — add `opentype.js`.
- `src/components/cutter/FontPicker.tsx` — parse family from the file bytes before calling `createFontUpload`; on selection of an unverified legacy font, re-parse + call `updateFontFamily`.
- `src/lib/fonts.functions.ts` — add `updateFontFamily` server fn (uploader-scoped UPDATE).
- (No changes needed to `operations.ts`, `useFonts.ts`, `CuePreview.tsx`, `LiveSubtitleOverlay.tsx`, or the DB schema — they already thread the family string end-to-end.)

## Out of scope

- Extracting weight/style axes; parsing variable-font instances.
- Server-side font parsing (would require a WASM opentype build in the Worker; not worth it since upload is a user action).
