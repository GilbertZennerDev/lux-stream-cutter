import { createFileRoute } from "@tanstack/react-router";

const LUXASR_BASE = "https://luxasr.uni.lu";

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function submitJob(bytes: ArrayBuffer, contentType: string, filename: string) {
  const params = new URLSearchParams({
    language: "lb",
    diarization: "Disabled",
    outfmt: "json",
  });
  const res = await fetch(`${LUXASR_BASE}/asr2?${params.toString()}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType || "audio/mpeg",
      "X-Filename": filename,
    },
    body: bytes,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`LuxASR submit failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as { job_id?: string };
  if (!data.job_id) throw new Error("LuxASR did not return a job_id");
  return data.job_id;
}

export const Route = createFileRoute("/api/asr")({
  server: {
    handlers: {
      // Submit a new job. Returns { jobId } quickly; client polls status.
      POST: async ({ request }) => {
        try {
          const contentType = request.headers.get("content-type") ?? "audio/mpeg";
          const filename = request.headers.get("x-filename") ?? "audio.mp3";
          const bytes = await request.arrayBuffer();
          if (bytes.byteLength === 0) return jsonError("Empty body", 400);
          if (bytes.byteLength > 100 * 1024 * 1024)
            return jsonError("File too large (max 100MB)", 413);
          const jobId = await submitJob(bytes, contentType, filename);
          return Response.json({ jobId });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return jsonError(message, 502);
        }
      },
      // Poll a job. ?jobId=... → { status } or { status:'completed', result }
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          const jobId = url.searchParams.get("jobId");
          if (!jobId) return jsonError("Missing jobId", 400);
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(jobId)) return jsonError("Invalid jobId", 400);
          const safeJobId = encodeURIComponent(jobId);
          const statusRes = await fetch(`${LUXASR_BASE}/v3/asr/jobs/${safeJobId}`);
          if (!statusRes.ok)
            return jsonError(`Poll failed: ${statusRes.status}`, 502);
          const j = (await statusRes.json()) as { status?: string; error?: string };
          if (j.status === "failed")
            return jsonError(`LuxASR job failed: ${j.error ?? ""}`, 502);
          if (j.status !== "completed") return Response.json({ status: j.status ?? "pending" });
          const resultRes = await fetch(`${LUXASR_BASE}/v3/asr/jobs/${safeJobId}/result`);
          if (!resultRes.ok)
            return jsonError(`Result fetch failed: ${resultRes.status}`, 502);
          const result = await resultRes.json();
          return Response.json({ status: "completed", result });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return jsonError(message, 502);
        }
      },
    },
  },
});
