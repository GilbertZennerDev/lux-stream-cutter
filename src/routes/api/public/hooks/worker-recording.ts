import { createFileRoute } from "@tanstack/react-router";

import { z } from "zod";
import type { Json } from "@/integrations/supabase/types";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Worker-Signature",
} as const;

const RECORDINGS_BUCKET = "recordings";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CreateInput = z.object({
  action: z.literal("create"),
  sessionDate: isoDate,
  chunkIndex: z.number().int(),
  startedAt: z.string(),
  sourceUrl: z.string().url().optional(),
  title: z.string().max(200).optional(),
  fileExt: z.string().regex(/^[a-zA-Z0-9]{1,8}$/).optional(),
  fullCopy: z.boolean().optional(),
});

const ReadyInput = z.object({
  action: z.literal("ready"),
  id: z.string().uuid(),
  endedAt: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  audioStatus: z.string().max(40).nullable().optional(),
  audioDetails: z.record(z.any()).nullable().optional(),
});

const FailedInput = z.object({
  action: z.literal("failed"),
  id: z.string().uuid(),
  error: z.string().max(500),
  audioStatus: z.string().max(40).nullable().optional(),
  audioDetails: z.record(z.any()).nullable().optional(),
});

// Called by the worker on startup. Marks any row this worker owns that is
// still "uploading" as failed, so a crash/redeploy self-heals instead of
// waiting for the 30-min janitor.
const ReapInput = z.object({
  action: z.literal("reap"),
  reason: z.string().max(200).optional(),
});

const Input = z.discriminatedUnion("action", [CreateInput, ReadyInput, FailedInput, ReapInput]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function verifySignature(rawBody: string, signature: string | null): Promise<boolean> {
  const secret = process.env.WORKER_SIGNING_SECRET ?? "";
  if (!secret || !signature) return false;
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/public/hooks/worker-recording")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }: { request: Request }) => {
        const raw = await request.text();
        const sig = request.headers.get("x-worker-signature");
        if (!(await verifySignature(raw, sig))) {
          return json({ error: "unauthorized" }, 401);
        }

        let parsed;
        try {
          parsed = Input.parse(JSON.parse(raw));
        } catch (err) {
          return json({ error: "invalid_input", message: (err as Error).message }, 400);
        }

        const workerUserId = process.env.WORKER_USER_ID;
        if (!workerUserId) return json({ error: "worker_user_id_unset" }, 500);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        try {
          if (parsed.action === "create") {
            const ext = parsed.fileExt ?? "ts";
            const path = `${workerUserId}/${parsed.sessionDate}/${parsed.startedAt.replace(/[:.]/g, "-")}_${parsed.chunkIndex}.${ext}`;
            const workerGroupId = process.env.WORKER_GROUP_ID ?? null;
            const { data: row, error } = await supabaseAdmin
              .from("recordings")
              .insert({
                user_id: workerUserId,
                group_id: workerGroupId,
                session_date: parsed.sessionDate,
                chunk_index: parsed.chunkIndex,
                started_at: parsed.startedAt,
                storage_path: path,
                status: "uploading",
                source_url: parsed.sourceUrl ?? null,
                title: parsed.title ?? null,
                full_copy: parsed.fullCopy ?? false,
              })
              .select("id, storage_path")
              .single();
            if (error) throw new Error(error.message);
            const { data: signed, error: sErr } = await supabaseAdmin.storage
              .from(RECORDINGS_BUCKET)
              .createSignedUploadUrl(row.storage_path);
            if (sErr) throw new Error(sErr.message);
            return json({
              id: row.id,
              path: row.storage_path,
              uploadUrl: signed.signedUrl,
              token: signed.token,
            });
          }
          if (parsed.action === "ready") {
            const { error } = await supabaseAdmin
              .from("recordings")
              .update({
                status: "ready",
                ended_at: parsed.endedAt,
                size_bytes: parsed.sizeBytes,
                audio_status: parsed.audioStatus ?? null,
                audio_details: (parsed.audioDetails ?? null) as Json | null,
              })
              .eq("id", parsed.id);
            if (error) throw new Error(error.message);
            return json({ ok: true });
          }
          // failed
          await supabaseAdmin
            .from("recordings")
              .update({
                status: "failed",
                error: parsed.error,
                audio_status: parsed.audioStatus ?? "failed",
                audio_details: (parsed.audioDetails ?? null) as Json | null,
              })
            .eq("id", parsed.id);
          return json({ ok: true });
        } catch (err) {
          return json({ error: (err as Error).message }, 500);
        }
      },
    },
  },
} as any);
