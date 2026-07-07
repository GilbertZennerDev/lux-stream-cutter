import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

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
  .inputValidator((input) => CreateInput.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const ext = data.fileExt ?? "ts";
    const path = `${data.sessionDate}/${data.startedAt.replace(/[:.]/g, "-")}_${data.chunkIndex}.${ext}`;
    const { data: row, error } = await supabaseAdmin
      .from("recordings")
      .insert({
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
    const { data: signed, error: sErr } = await supabaseAdmin.storage
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
  .inputValidator((input) => MarkReadyInput.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("recordings")
      .update({
        status: "ready",
        ended_at: data.endedAt,
        size_bytes: data.sizeBytes,
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const markRecordingFailed = createServerFn({ method: "POST" })
  .inputValidator((input) => MarkFailedInput.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("recordings")
      .update({ status: "failed", error: data.error })
      .eq("id", data.id);
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
}

export const listRecordings = createServerFn({ method: "GET" }).handler(
  async (): Promise<RecordingRow[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("recordings")
      .select("*")
      .order("session_date", { ascending: false })
      .order("chunk_index", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    return (data ?? []) as RecordingRow[];
  },
);

export const getRecordingDownloadUrl = createServerFn({ method: "POST" })
  .inputValidator((input) => IdInput.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("recordings")
      .select("storage_path, status, title, transcript, transcript_srt, transcribed_at")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    if (row.status !== "ready") throw new Error(`Recording not ready (${row.status})`);
    const { data: signed, error: sErr } = await supabaseAdmin.storage
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
  .inputValidator((input) => SaveTranscriptInput.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("recordings")
      .update({
        transcript: data.cues,
        transcript_srt: data.srt,
        transcribed_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });


export const deleteRecording = createServerFn({ method: "POST" })
  .inputValidator((input) => IdInput.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("recordings")
      .select("storage_path")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    await supabaseAdmin.storage.from(RECORDINGS_BUCKET).remove([row.storage_path]);
    const { error: dErr } = await supabaseAdmin.from("recordings").delete().eq("id", data.id);
    if (dErr) throw new Error(dErr.message);
    return { ok: true };
  });
