## Goal

Automatically record the Chamber TV HLS stream every Tue/Wed/Thu 14:00–24:00 Europe/Luxembourg and upload chunks to the existing `recordings` bucket — with no browser tab open.

## Reality check

Cloudflare Workers (where server functions and server routes run today) can't hold a 4-hour HLS capture: strict CPU/wall-time limits per request, no long-lived background tasks. So an "always-on server worker" cannot live inside this Lovable project. It has to run somewhere else and just talk to Lovable Cloud storage + the `recordings` table.

## Approach

A tiny Node.js worker service, deployed to a cheap always-on host (Fly.io, Railway, Render, or a $5 VPS). It reuses the existing schedule + upload logic.

```text
┌─────────────────────┐        HTTPS         ┌──────────────────────┐
│  Node worker (24/7) │ ───── uploads ─────▶ │  Lovable Cloud       │
│  - schedule loop    │                      │  - recordings bucket │
│  - HLS recorder     │                      │  - recordings table  │
└─────────────────────┘                      └──────────────────────┘
```

### What the worker does

1. Every minute, check `isInSession(now)` (ported from `src/lib/schedule.ts`).
2. When a session starts: begin recording the HLS playlist, rotating chunks every 5 min (mirrors `startScheduledRecording`).
3. For each chunk: call the existing `create_recording` / `mark_recording_ready` RPCs (or an internal `/api/public/hooks/*` endpoint) with a service token, then upload the `.ts` blob to the `recordings` bucket via signed URL.
4. When the session ends: stop, upload the last chunk, sleep until the next session.

### What changes in this repo

- **New folder `worker/**` — standalone Node app (own `package.json`), sharing code with `src/lib/schedule.ts` and `src/lib/hls/recorder.ts` (extract the Node-safe parts; the current recorder is browser-only, needs a Node port using `undici`/`node:fetch` and `fs`/memory buffers instead of `MediaSource`).
- **New public endpoint** `/api/public/hooks/worker-create-recording` (HMAC-signed) so the worker doesn't need `SUPABASE_SERVICE_ROLE_KEY` — it calls this endpoint, which uses `supabaseAdmin` server-side to create the row + return a signed upload URL. Same pattern as `cleanup-recordings.ts`.
- **New shared secret** `WORKER_SIGNING_SECRET` for HMAC auth on that endpoint.
- **Deploy config** — `worker/Dockerfile` + `fly.toml` (or Railway config, depending on choice).

### What stays the same

- Existing schedule, bucket, table, RLS policies.
- Existing browser recorder (Studio / Cutter) keeps working; the server worker is additive.

## Effort estimate


| Task                                                      | Effort          |
| --------------------------------------------------------- | --------------- |
| Port `recorder.ts` to Node (fetch loop, no `MediaSource`) | 3–4 h           |
| Worker skeleton (schedule loop, chunk rotation, retry)    | 2–3 h           |
| Signed public endpoint for row-create + upload URL        | 1 h             |
| Dockerfile + deploy to Fly.io/Railway, env wiring         | 1–2 h           |
| Testing across a real Tue session, DST edge, retries      | 2 h             |
| **Total**                                                 | **~1–1.5 days** |


## Ongoing cost

$0–7/month for the host (Fly.io free tier fits; Railway ~$5; VPS ~$5). Lovable Cloud storage costs scale with retention (already capped at 30 days by `cleanup-recordings`).

## Open decisions before I build

1. **Where to deploy** — Fly.io (free tier, Docker), Railway (easiest, ~$5), or your own VPS?
2. **Full-session copy** — also keep the parallel `fullCopy` recorder from `scheduled-recorder.ts`, or chunks only?
3. **Alerting** — do you want a webhook/email if a session fails to record?