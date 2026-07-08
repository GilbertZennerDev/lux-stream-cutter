import { createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

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

/**
 * Stream a file to the signed URL. Never loads the file into memory.
 * Times out after 5 min per attempt, retries once.
 */
export async function uploadFileToSignedUrl(uploadUrl, filePath, contentType = "video/mp2t") {
  const TIMEOUT_MS = 300_000;
  const { size } = await stat(filePath);

  const attempt = async () => {
    const nodeStream = createReadStream(filePath, { highWaterMark: 256 * 1024 });
    const webStream = Readable.toWeb(nodeStream);
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(size),
        "x-upsert": "true",
      },
      body: webStream,
      duplex: "half",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`upload ${res.status}: ${text}`);
    }
    return size;
  };
  try {
    return await attempt();
  } catch (err) {
    await new Promise((r) => setTimeout(r, 2000));
    return await attempt();
  }
}

// Legacy in-memory upload kept for callers that still pass a Buffer.
export async function uploadToSignedUrl(uploadUrl, buffer, contentType = "video/mp2t") {
  const TIMEOUT_MS = 300_000;
  const attempt = async () => {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType, "x-upsert": "true" },
      body: buffer,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`upload ${res.status}: ${text}`);
    }
  };
  try {
    await attempt();
  } catch (err) {
    await new Promise((r) => setTimeout(r, 2000));
    await attempt();
  }
}
