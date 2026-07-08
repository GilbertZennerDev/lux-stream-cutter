## Root cause

The Fly worker is being killed mid-chunk (OOM on the default 256 MB `shared-cpu-1x`), so `uploadToSignedUrl` + `markReady` never run and the DB row is left at `uploading`.

Evidence:
- 6 hook calls in the last hour, all of them `create` (200). Zero `ready`, zero `failed`. If uploads were merely slow, we'd still see `ready`/`failed` eventually.
- Every stuck row has `chunk_index = 0`. `runSession()` resets that counter to 0, so six 0's in one active session means the process restarted six times.
- Timing: create → ~5 min → create → ~5 min… matches "spin up, buffer chunk in RAM, call `stop()` + `createRecording`, die before upload finishes".
- Yesterday's session (before the memory pressure appeared) recorded chunks 0,1,2,3 with correct `size_bytes` on the same code — so the app logic is fine.

Why memory: a 5-min Chamber TV MPEG-TS chunk is ~100–150 MB held as a Node `Buffer`. During rotation the worker briefly holds chunk N (uploading) and chunk N+1 (recording) at the same time → peak >250 MB → OOM.

## Fix (user action on Fly, no code change)

```powershell
fly scale memory 1024 --app luxstream-worker
fly logs --app luxstream-worker
```

Bumping to 1 GB gives ~4× headroom over peak. 2 GB if you want to also record the parallel full-session copy later without worrying.

## Cleanup

The 6 stuck `uploading` rows are dead — the buffers they refer to were never uploaded. Mark them failed so they stop cluttering the list:

```sql
UPDATE public.recordings
   SET status = 'failed',
       error  = 'worker OOM before upload'
 WHERE status = 'uploading'
   AND created_at < now() - interval '10 minutes';
```

## Verification

After the resize, during the next active window you should see in `fly logs`:

- `chunk 0 recording…`
- `chunk 0 uploaded (NN.N MB)`
- `chunk 1 recording…`

and in the DB, rows with `status = 'ready'`, non-zero `size_bytes`, `ended_at` set, and `chunk_index` incrementing 0,1,2,3….

## Not doing (unless the resize doesn't hold)

- Streaming uploads instead of buffering — bigger refactor, only worth it if 1–2 GB still isn't enough.
- Shrinking `CHUNK_MS` to 2 min — masks the real issue.
