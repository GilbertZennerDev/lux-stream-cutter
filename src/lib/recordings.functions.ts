import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const RECORDINGS_BUCKET = "recordings";
const DOWNLOAD_EXPIRES_SEC = 60 * 60; // 1h

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CreateInput = z.object({
  sessionDate: isoDate,
  chunkIndex: z.number().int(),
  startedAt: z.string(),
  sourceUrl: z.string().url().optional(),
  title: z.string().max(200).optional(),
  fileExt: z.string().regex(/^[a-zA-Z0-9]{1,8}$/).optional(),
  fullCopy: z.boolean().optional(),
});

const MarkReadyInput = z.object({
  id: z.string().uuid(),
  endedAt: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

const MarkFailedInput = z.object({
  id: z.string().uuid(),
  error: z.string().max(500),
});

const IdInput = z.object({ id: z.string().uuid() });

const SaveTranscriptInput = z.object({
  id: z.string().uuid(),
  cues: z.array(z.object({
    index: z.number().int().nonnegative().optional(),
    start: z.number(),
    end: z.number(),
    text: z.string(),
  })),
  srt: z.string(),
});

/** Create a DB row for a new chunk and return a signed upload URL for it. */
export const createRecording = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => CreateInput.parse(input))
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const ext = data.fileExt ?? "ts";
    const path = `${userId}/${data.sessionDate}/${data.startedAt.replace(/[:.]/g, "-")}_${data.chunkIndex}.${ext}`;
    const { data: row, error } = await context.supabase
      .from("recordings")
      .insert({
        user_id: userId,
        session_date: data.sessionDate,
        chunk_index: data.chunkIndex,
        started_at: data.startedAt,
        storage_path: path,
        status: "uploading",
        source_url: data.sourceUrl ?? null,
        title: data.title ?? null,
        full_copy: data.fullCopy ?? false,
      })
      .select("id, storage_path")
      .single();

    if (error) throw new Error(error.message);
    const { data: signed, error: sErr } = await context.supabase.storage
      .from(RECORDINGS_BUCKET)
      .createSignedUploadUrl(row.storage_path);
    if (sErr) throw new Error(sErr.message);
    return {
      id: row.id,
      path: row.storage_path,
      uploadUrl: signed.signedUrl,
      token: signed.token,
    };
  });

export const markRecordingReady = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => MarkReadyInput.parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("recordings")
      .update({
        status: "ready",
        ended_at: data.endedAt,
        size_bytes: data.sizeBytes,
      })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const markRecordingFailed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => MarkFailedInput.parse(input))
  .handler(async ({ data, context }) => {
    await context.supabase
      .from("recordings")
      .update({ status: "failed", error: data.error })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    return { ok: true };
  });

export interface RecordingRow {
  id: string;
  session_date: string;
  chunk_index: number;
  started_at: string;
  ended_at: string | null;
  storage_path: string;
  size_bytes: number;
  status: string;
  source_url: string | null;
  title: string | null;
  error: string | null;
  created_at: string;
  transcript: Array<{ index?: number; start: number; end: number; text: string }> | null;
  transcript_srt: string | null;
  transcribed_at: string | null;
  full_copy: boolean;
}

export const listRecordings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<RecordingRow[]> => {
    const { data, error } = await context.supabase
      .from("recordings")
      .select("*")
      .eq("user_id", context.userId)
      .order("session_date", { ascending: false })
      .order("chunk_index", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    return (data ?? []) as RecordingRow[];
  });

export const getRecordingDownloadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => IdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("recordings")
      .select("storage_path, status, title, transcript, transcript_srt, transcribed_at")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .single();
    if (error) throw new Error(error.message);
    if (row.status !== "ready") throw new Error(`Recording not ready (${row.status})`);
    const { data: signed, error: sErr } = await context.supabase.storage
      .from(RECORDINGS_BUCKET)
      .createSignedUrl(row.storage_path, DOWNLOAD_EXPIRES_SEC);
    if (sErr) throw new Error(sErr.message);
    return {
      url: signed.signedUrl,
      path: row.storage_path,
      title: row.title as string | null,
      transcript: (row.transcript ?? null) as RecordingRow["transcript"],
      transcriptSrt: (row.transcript_srt ?? null) as string | null,
      transcribedAt: (row.transcribed_at ?? null) as string | null,
    };
  });

export const saveRecordingTranscript = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => SaveTranscriptInput.parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("recordings")
      .update({
        transcript: data.cues,
        transcript_srt: data.srt,
        transcribed_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteRecording = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => IdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("recordings")
      .select("storage_path")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .single();
    if (error) throw new Error(error.message);
    await context.supabase.storage.from(RECORDINGS_BUCKET).remove([row.storage_path]);
    const { error: dErr } = await context.supabase
      .from("recordings")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (dErr) throw new Error(dErr.message);
    return { ok: true };
  });
