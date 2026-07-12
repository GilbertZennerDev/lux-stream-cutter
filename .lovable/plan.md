## Goal

Add a Fonts manager where uploaded font files land **as full binary content** in the private `fonts` storage bucket, so we can later fetch the actual file bytes (e.g. to feed ffmpeg's `/fonts` dir for burn-in). Today the `fonts` table + `fonts` bucket exist but no upload UI exists, so nothing ever writes real bytes.

## Where

New Fonts section on `src/routes/admin.tsx` (super-admin only, matches existing gating). No changes to other routes.

## Upload flow (client-side, private bucket)

For each accepted file (`.ttf`, `.otf`, `.woff`, `.woff2`):

1. Derive `family` from filename (strip extension, replace `_`/`-` runs with spaces), `format` from extension, `size_bytes` from `file.size`.
2. `storage_path = ${user.id}/${crypto.randomUUID()}-${safeName}`.
3. `supabase.storage.from("fonts").upload(storage_path, file, { contentType: file.type || "font/*", upsert: false })` — this streams the **actual File** object, so the bucket object contains the exact bytes of the uploaded file (verifiable later via `download()` / signed URL).
4. On success, `supabase.from("fonts").insert({ family, original_filename: file.name, storage_path, format, size_bytes, status: "ready", uploaded_by: user.id })`.
5. On DB-insert failure, roll back with `storage.from("fonts").remove([storage_path])` so we never leave orphaned objects.

Upload queue runs files sequentially with per-file progress + toast; a shared React Query `["fonts"]` list is invalidated after each success.

## List / manage

- `useQuery(["fonts"])` → `select * from fonts order by created_at desc`.
- Row shows: family, format badge, size (KB/MB), uploaded date, "Default" toggle, Delete button.
- **Default toggle**: sets `is_default=true` on the row; a small server function (or a two-step client update wrapped in a transaction-ish sequence) first clears all `is_default=true` then sets the chosen row. Uses the existing partial-unique index `fonts_only_one_default`. Since RLS only lets the uploader update their own row, the toggle is disabled for rows owned by other admins and shows a hint. (Out of scope: cross-admin default management.)
- **Delete**: `storage.remove([storage_path])` then `delete from fonts where id=…`. RLS already restricts to uploader.

## Storage bucket policies

The `fonts` bucket already exists and is private. Add RLS on `storage.objects` (via migration in build mode) so authenticated users can `INSERT`/`SELECT`/`DELETE` inside `bucket_id = 'fonts'` scoped to their own top-level folder (`auth.uid()::text = (storage.foldername(name))[1]`). Needed because private buckets have no default write policy.

## Reading the file content later (out of scope for this task, but the plan enables it)

- Client: `supabase.storage.from("fonts").download(storage_path)` → `Blob` → `ArrayBuffer` → `ffmpeg.writeFile("/fonts/<family>.<ext>", bytes)`.
- Server (worker/burn): server-side `supabaseAdmin.storage.from("fonts").download(...)` returns raw bytes.

This task only guarantees the bytes are stored; the burn-side hookup stays for a follow-up.

## Files

- **New** `src/components/admin/FontsManager.tsx` — dropzone + list + row actions (dropzone patterned after `PremiereDropzone`).
- **Edit** `src/routes/admin.tsx` — mount `<FontsManager />` as a new `Card` section.
- **Migration** — add three RLS policies on `storage.objects` for bucket `fonts` (insert/select/delete for `authenticated`, folder-scoped to `auth.uid()`).

## Verification

- Upload a `.ttf`, then in the shell: `psql -c "select storage_path, size_bytes from fonts order by created_at desc limit 1"` and check that `size_bytes` matches the local file; download via signed URL and `sha256sum` the bytes vs the original to prove full content is stored (not just the name).
- `tsgo --noEmit` clean.

## Out of scope

- Wiring uploaded fonts into the burn pipeline (`operations.ts` still uses the bundled Noto Sans).
- Non-admin upload access, font previews, per-project font selection.
