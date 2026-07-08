import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
} as const;

const RETENTION_DAYS = 30;
const STUCK_UPLOAD_MINUTES = 30;

export const Route = createFileRoute("/api/public/hooks/cleanup-recordings")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }: { request: Request }) => {
        // Gate on a dedicated server-only secret (CRON_SECRET). The Supabase
        // publishable key is shipped to every browser and is not a credential.
        const provided =
          request.headers.get("x-cron-secret") ??
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
          "";
        const expected = process.env.CRON_SECRET ?? "";
        if (!expected || provided !== expected) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...CORS },
          });
        }

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();

          const { data: rows, error } = await supabaseAdmin
            .from("recordings")
            .select("id, storage_path")
            .lt("created_at", cutoff)
            .limit(500);
          if (error) throw new Error(error.message);

          const paths = (rows ?? []).map((r) => r.storage_path).filter(Boolean);
          if (paths.length > 0) {
            await supabaseAdmin.storage.from("recordings").remove(paths);
            await supabaseAdmin
              .from("recordings")
              .delete()
              .in(
                "id",
                (rows ?? []).map((r) => r.id),
              );
          }
          // Auto-fail rows stuck in "uploading" past STUCK_UPLOAD_MINUTES: the
          // worker create hook succeeded but ready/failed never arrived (upload
          // PUT hung or worker cycled). Prevents orphan rows piling up.
          const stuckCutoff = new Date(
            Date.now() - STUCK_UPLOAD_MINUTES * 60_000,
          ).toISOString();
          const { data: stuck, error: stuckErr } = await supabaseAdmin
            .from("recordings")
            .update({
              status: "failed",
              error: `Upload never completed within ${STUCK_UPLOAD_MINUTES} min (auto-failed by janitor).`,
            })
            .eq("status", "uploading")
            .lt("created_at", stuckCutoff)
            .select("id");
          if (stuckErr) throw new Error(stuckErr.message);

          return new Response(
            JSON.stringify({
              ok: true,
              deleted: paths.length,
              stuckFailed: stuck?.length ?? 0,
              cutoff,
            }),
            { headers: { "Content-Type": "application/json", ...CORS } },
          );
        } catch (err) {
          return new Response(
            JSON.stringify({ error: (err as Error).message }),
            { status: 500, headers: { "Content-Type": "application/json", ...CORS } },
          );
        }
      },
    },
  },
} as any);
