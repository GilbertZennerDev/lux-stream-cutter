import { createFileRoute } from "@tanstack/react-router";

const LUXASR_BASE = "https://luxasr.uni.lu";
const POLL_INTERVAL_MS = 2500;
const MAX_POLL_MS = 10 * 60 * 1000; // 10 minutes

async function submitJob(bytes: ArrayBuffer, contentType: string, filename: string) {
  const params = new URLSearchParams({
    language: "lb",
    diarization: "Disabled",
    outfmt: "json",
  });
  const headers: Record<string, string> = {
    "Content-Type": contentType || "audio/mpeg",
    "X-Filename": filename,
  };



  const res = await fetch(`${LUXASR_BASE}/asr2?${params.toString()}`, {
    method: "POST",
    headers,
    body: bytes,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`LuxASR submit failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as { job_id?: string; status?: string };
  if (!data.job_id) throw new Error("LuxASR did not return a job_id");
  return data.job_id;
}

async function pollJob(jobId: string): Promise<"completed"> {
  const headers: Record<string, string> = {};

  const started = Date.now();
  while (Date.now() - started < MAX_POLL_MS) {
    const res = await fetch(`${LUXASR_BASE}/v3/asr/jobs/${jobId}`, { headers });
    if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
    const j = (await res.json()) as { status?: string; error?: string };
    if (j.status === "completed") return "completed";
    if (j.status === "failed") throw new Error(`LuxASR job failed: ${j.error ?? ""}`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("LuxASR polling timed out");
}

async function fetchResult(jobId: string): Promise<unknown> {
  const res = await fetch(`${LUXASR_BASE}/v3/asr/jobs/${jobId}/result`);

  if (!res.ok) throw new Error(`Result fetch failed: ${res.status}`);
  return res.json();
}

export const Route = createFileRoute("/api/asr")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const contentType = request.headers.get("content-type") ?? "audio/mpeg";
          const filename = request.headers.get("x-filename") ?? "audio.mp3";
          const bytes = await request.arrayBuffer();
          if (bytes.byteLength === 0) {
            return new Response(JSON.stringify({ error: "Empty body" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          }
          if (bytes.byteLength > 200 * 1024 * 1024) {
            return new Response(JSON.stringify({ error: "File too large (max 200MB)" }), {
              status: 413,
              headers: { "content-type": "application/json" },
            });
          }
          const jobId = await submitJob(bytes, contentType, filename);
          await pollJob(jobId);
          const result = await fetchResult(jobId);
          return Response.json({ jobId, result });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return new Response(JSON.stringify({ error: message }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        }
      },
    },
  },
});
