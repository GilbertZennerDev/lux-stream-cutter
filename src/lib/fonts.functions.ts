import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const BUCKET = "fonts";
const READ_URL_TTL = 60 * 60 * 24; // 24h

const CreateUpload = z.object({
  filename: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive().max(5 * 1024 * 1024, "Max 5 MB"),
  format: z.enum(["ttf", "otf", "woff", "woff2"]),
  family: z.string().min(1).max(120),
});

const IdInput = z.object({ id: z.string().uuid() });

const UpdateFamily = z.object({
  id: z.string().uuid(),
  family: z.string().min(1).max(120),
});

export interface FontRow {
  id: string;
  family: string;
  originalFilename: string | null;
  storagePath: string;
  format: string;
  sizeBytes: number;
  status: string;
  isDefault: boolean;
  uploadedBy: string;
  createdAt: string;
  /** Signed URL to fetch the font file (valid ~24h). Null for pending rows. */
  url: string | null;
}

export const listFonts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<FontRow[]> => {
    const { data, error } = await context.supabase
      .from("fonts")
      .select("id, family, original_filename, storage_path, format, size_bytes, status, is_default, uploaded_by, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const rows = data ?? [];

    // Sign URLs for ready rows in one batch.
    const ready = rows.filter((r) => r.status === "ready");
    const paths = ready.map((r) => r.storage_path);
    const urlByPath = new Map<string, string>();
    if (paths.length > 0) {
      const { data: signed, error: sErr } = await context.supabase.storage
        .from(BUCKET)
        .createSignedUrls(paths, READ_URL_TTL);
      if (sErr) throw new Error(sErr.message);
      for (const s of signed ?? []) {
        if (s.signedUrl && s.path) urlByPath.set(s.path, s.signedUrl);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      family: r.family,
      originalFilename: r.original_filename,
      storagePath: r.storage_path,
      format: r.format,
      sizeBytes: r.size_bytes,
      status: r.status,
      isDefault: r.is_default,
      uploadedBy: r.uploaded_by,
      createdAt: r.created_at,
      url: urlByPath.get(r.storage_path) ?? null,
    }));
  });

/**
 * Creates a pending font row and returns a signed upload URL. The client then
 * uploads the file, then calls `markFontReady`.
 */
export const createFontUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => CreateUpload.parse(input))
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    // Include timestamp so re-uploads with the same filename don't collide.
    const safe = data.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${userId}/${Date.now()}_${safe}`;

    const { data: row, error } = await context.supabase
      .from("fonts")
      .insert({
        family: data.family,
        original_filename: data.filename,
        storage_path: path,
        format: data.format,
        size_bytes: data.sizeBytes,
        status: "pending",
        is_default: false,
        uploaded_by: userId,
      })
      .select("id, storage_path")
      .single();
    if (error) throw new Error(error.message);

    const { data: signed, error: sErr } = await context.supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(row.storage_path);
    if (sErr) throw new Error(sErr.message);

    return {
      id: row.id,
      path: row.storage_path,
      uploadUrl: signed.signedUrl,
      token: signed.token,
    };
  });

export const markFontReady = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => IdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("fonts")
      .update({ status: "ready" })
      .eq("id", data.id)
      .eq("uploaded_by", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Flips the shared default. Runs with the service-role client because the
 * per-row UPDATE policy is scoped to uploader — any signed-in user should be
 * able to change the shared default.
 */
export const setDefaultFont = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => IdInput.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Clear existing default, then set the new one. Two statements is fine —
    // the partial unique index makes concurrent writers safe (one will fail
    // and the client retries by refetching).
    const { error: clearErr } = await supabaseAdmin
      .from("fonts")
      .update({ is_default: false })
      .eq("is_default", true);
    if (clearErr) throw new Error(clearErr.message);

    const { error: setErr } = await supabaseAdmin
      .from("fonts")
      .update({ is_default: true })
      .eq("id", data.id);
    if (setErr) throw new Error(setErr.message);

    return { ok: true };
  });

export const deleteFont = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => IdInput.parse(input))
  .handler(async ({ data, context }) => {
    // Fetch path so we can remove the storage object.
    const { data: row, error } = await context.supabase
      .from("fonts")
      .select("storage_path, uploaded_by")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    if (row.uploaded_by !== context.userId) {
      throw new Error("You can only delete fonts you uploaded.");
    }
    // Remove storage object first (best-effort).
    await context.supabase.storage.from(BUCKET).remove([row.storage_path]).catch(() => {});
    const { error: dErr } = await context.supabase
      .from("fonts")
      .delete()
      .eq("id", data.id);
    if (dErr) throw new Error(dErr.message);
    return { ok: true };
  });
