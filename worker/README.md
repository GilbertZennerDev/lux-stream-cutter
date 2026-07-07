# LuxStream auto-recorder worker

Always-on Node service that records the Chamber TV HLS stream every
**Tuesday–Thursday 14:00–18:00 Europe/Luxembourg** in 5-minute chunks and
uploads each chunk to the Lovable Cloud `recordings` bucket via the signed
public hook at `/api/public/hooks/worker-recording`.

No browser tab required. No app deploy required to change the schedule — just
edit `src/schedule.mjs` and redeploy.

## Files

- `src/index.mjs` — main loop (schedule check + chunk rotation).
- `src/recorder.mjs` — HLS video capture (Node fetch, no ffmpeg).
- `src/schedule.mjs` — mirrors `src/lib/schedule.ts` from the app.
- `src/uploader.mjs` — HMAC-signed calls to the app's public hook.
- `src/parsePlaylist.mjs` — minimal m3u8 parser.

## Config (env vars)

| Var | Required | Description |
|---|---|---|
| `LUXSTREAM_API_BASE` | yes | Base URL of the Lovable app, e.g. `https://lux-stream-cutter.lovable.app` |
| `WORKER_SIGNING_SECRET` | yes | Same value as the `WORKER_SIGNING_SECRET` secret configured in the Lovable project |
| `PLAYLIST_URL` | no | HLS playlist to record (defaults to Chamber TV HD) |
| `CHUNK_MS` | no | Chunk length in ms (default 300000 = 5 min) |

## Deploy to Fly.io (free tier)

Prereqs: install [`flyctl`](https://fly.io/docs/hands-on/install-flyctl/) and
run `fly auth login`.

```bash
cd worker

# 1. Create the app (skip deploy so we can set secrets first).
fly launch --no-deploy --copy-config --name luxstream-worker --region cdg

# 2. Set secrets (get WORKER_SIGNING_SECRET from Lovable → Cloud → Secrets).
fly secrets set WORKER_SIGNING_SECRET="paste-value-here"

# 3. Deploy.
fly deploy

# 4. Watch it work.
fly logs
```

Free-tier machine (`shared-cpu-1x`, 512 MB) is enough — the worker holds one
chunk (~30 MB) in memory at a time.

## Deploy elsewhere

Any Docker host works. The image is a plain Node 20 alpine container with no
extra deps:

```bash
docker build -t luxstream-worker worker/
docker run -d --restart=always \
  -e LUXSTREAM_API_BASE=https://lux-stream-cutter.lovable.app \
  -e WORKER_SIGNING_SECRET=... \
  luxstream-worker
```

## Testing without waiting for Tuesday

Temporarily add today's weekday to `SCHEDULE.weekdays` in `src/schedule.mjs`
(and shift `startHour`/`endHour` around the current time), redeploy, verify a
row appears in the `recordings` table with `status='ready'`, then revert.

## Security notes

- The `/api/public/hooks/worker-recording` endpoint requires HMAC-SHA256
  signatures over the raw request body using `WORKER_SIGNING_SECRET`.
- Rotate the secret by generating a new one in Lovable → Cloud → Secrets and
  running `fly secrets set WORKER_SIGNING_SECRET=<new>` — old worker instances
  will start failing signatures within seconds of the new secret going live.
- Uploaded rows are owned by the `WORKER_USER_ID` set in the Lovable project.
