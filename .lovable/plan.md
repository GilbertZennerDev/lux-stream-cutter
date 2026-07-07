## Status: clean

One machine, `started`, running the latest deployment. That's exactly right.

## Next: rotate the leaked signing secret

You pasted `WORKER_SIGNING_SECRET` in chat earlier, so it must be treated as public. Rotation is a 3-step, ~1-minute job:

### Step 1 — I generate a fresh value in Lovable Cloud

Once you approve this plan (switch to build mode), I'll call the secrets tool to overwrite `WORKER_SIGNING_SECRET` in Lovable Cloud with a new 64-char random value, then reveal it to you once in the secure form so you can copy it.

### Step 2 — You paste the new value into Fly

```powershell
fly secrets set WORKER_SIGNING_SECRET="<new value>" --app luxstream-worker
```

Fly restarts the machine automatically.

### Step 3 — Verify

```powershell
fly logs --app luxstream-worker
```

You should see the `up.` and `idle · next session ...` lines again. If they appear, both sides hold the same new secret and the old leaked one is dead.

## After rotation

Nothing more to do until tomorrow (Wed) 14:00 Luxembourg time — the worker will start recording automatically and rows will appear in the Recordings page as chunks upload.
