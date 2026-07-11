## Goal

Add font upload directly to the Cutter UI. Any signed-in user can upload a TTF/OTF/WOFF/WOFF2, pick one as the active font for the current session, and mark one as the shared default. The chosen font is used both in the transcript-block previews AND in the burned MP4, so preview and burn stay visually identical.

## UX (all inside `/` — Cutter route)

New compact "Font" control in the top style bar (next to font-size / outline):

- Dropdown listing all uploaded fonts (shows family name; the default is marked with a small star).
- "Upload font…" item at the bottom of the dropdown opens a native file picker (`.ttf,.otf,.woff,.woff2`, max 5 MB).
- "Set as default" toggle next to the dropdown — applies the currently selected font as the shared default for everyone.
- "Delete" (trash icon) next to the dropdown — only shown for fonts the current user uploaded (or to admins).

Selection is persisted per-session in `cutterSession` alongside `fontSize` / `subOutline`. On first load, falls back to the shared default; if none, falls back to Noto Sans (current behaviour).

## Data model

New table `public.fonts`:
- `id uuid pk`, `family text not null`, `original_filename text`, `storage_path text not null`, `format text` (`ttf|otf|woff|woff2`), `size_bytes int`, `is_default boolean default false`, `uploaded_by uuid not null references auth.users`, `created_at timestamptz default now()`.
- Partial unique index: only one row can have `is_default=true`.
- RLS: `SELECT` for `authenticated`; `INSERT` for `authenticated` (with `uploaded_by = auth.uid()`); `UPDATE`/`DELETE` for the uploader OR admins (`has_role(auth.uid(),'admin')`). `is_default` toggle allowed for any authenticated user (fonts are a shared team resource; behaviour matches how any user can change subtitle style).
- GRANTs: `SELECT, INSERT, UPDATE, DELETE` to `authenticated`; `ALL` to `service_role`.

New private storage bucket `fonts` with RLS letting authenticated users read all objects and insert/delete their own.

## Server functions (`src/lib/fonts.functions.ts`)

- `listFonts()` → rows + short-lived signed URLs (24h).
- `createFontUpload({ filename, sizeBytes, format })` → returns a signed upload URL + pending row id.
- `markFontReady({ id, family })` → flips status to ready with the parsed family name.
- `setDefaultFont({ id })` → clears other rows' `is_default` in a transaction, sets this one.
- `deleteFont({ id })` → removes storage object + row (RLS enforces uploader/admin check).

Family name is parsed client-side using `opentype.js` (lightweight, worker-safe) before calling `markFontReady`, so ASS `Fontname` and CSS `font-family` always match — critical for libass to actually load the font.

## Client wiring

- `src/lib/fonts/useFonts.ts` — TanStack Query hook: fetches font list, injects one `@font-face` per font into a singleton `<style>` tag on the document. Re-injects when signed URLs refresh.
- `src/components/cutter/FontPicker.tsx` — new dropdown + upload/set-default/delete controls.
- `src/routes/index.tsx` (Cutter):
  - New state `selectedFontFamily: string | null`, persisted in `cutterSession`.
  - Mount the `FontPicker` in the style bar.
  - Thread `fontFamily` into `CuePreview`, `LiveSubtitleOverlay` (replaces the hard-coded `font-sans` class with an inline `style={{ fontFamily }}`), and into `cuesToAss` / `burnSubtitles`.
- `src/lib/ffmpeg/operations.ts`:
  - Replace hard-coded `FONT_FAMILY = "Noto Sans"` / `FONT_URL` with values plumbed from the caller.
  - `ensureFont(ffmpeg, { family, url, format })` — writes the chosen font into `/fonts/<family>.<ext>` inside ffmpeg's virtual FS; tracks install per-ffmpeg-instance in a `Map<ffmpeg, Set<family>>` so switching fonts mid-session re-installs correctly (no false "already loaded" hits).
  - `cuesToAss` takes `style.fontFamily`. The ASS `Style:` line uses it, and the canvas `wrapCtx.font` uses it too so the word-wrap width match (established last turn) still holds.
  - Falls back to bundled Noto Sans when no font is selected.

## Verification

- `tsgo --noEmit`.
- Manual: upload a TTF from the Cutter → dropdown gets a new option → select it → transcript previews re-render with it. Set as default → reload → still selected. Burn a short clip → exported MP4 uses the same font, long cues wrap at the same points as the preview.

## Out of scope

- Per-cue font override (font is per-session, matching how `fontSize` works).
- Font subsetting / variable-font axes.
- Grouping multiple weights into one family entry (each file = one row).