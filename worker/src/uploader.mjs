import { createHmac } from "node:crypto";

const API_BASE = process.env.LUXSTREAM_API_BASE; // e.g. https://lux-stream-cutter.lovable.app
const SIGNING_SECRET = process.env.WORKER_SIGNING_SECRET;

if (!API_BASE) throw new Error("LUXSTREAM_API_BASE not set");
if (!SIGNING_SECRET) throw new Error("WORKER_SIGNING_SECRET not set");

const HOOK_URL = `${API_BASE.replace(/\/$/, "")}/api/public/hooks/worker-recording`;

async function signedPost(payload) {
  const body = JSON.stringify(payload);
  const sig = createHmac("sha256", SIGNING_SECRET).update(body).digest("hex");
  const res = await fetch(HOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Worker-Signature": sig },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`hook ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

export async function createRecording(input) {
  return signedPost({ action: "create", ...input });
}

export async function markReady(input) {
  return signedPost({ action: "ready", ...input });
}

export async function markFailed(input) {
  return signedPost({ action: "failed", ...input });
}

/** Upload a Buffer to the signed URL returned by createRecording. */
export async function uploadToSignedUrl(uploadUrl, buffer, contentType = "video/mp2t") {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "x-upsert": "true" },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upload ${res.status}: ${text}`);
  }
}
