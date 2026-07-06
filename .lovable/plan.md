
# Video Cutter & Auto-Subtitler Pro (Browser Edition)

Single-user web app. All video processing runs in the user's browser via `ffmpeg.wasm`. LuxASR is called from a TanStack server function so the API key stays server-side. No auth, no persistence — files live in the current tab session.

Scope for this build: **Cutter + Subtitler pipeline only**. Live stream recording is deferred (not feasible in-browser).

## Screens

1. **Dashboard** (`/`) — single page:
   - **Drop zone / file picker** for the source video (mp4/mkv/mov/ts/webm).
   - **Cut controls**: Start + End inputs. Smart parser accepts `SS`, `MM:SS`, `HH:MM:SS`. Live-shows computed duration.
   - **Subtitle options**: font size, max chars per line, max 2 sentences per cue (toggle), burn-in on/off.
   - **Run mode selector**:
     - Full pipeline (cut → audio → ASR → SRT → shorten → burn)
     - Just video (cut only)
     - Only subtitles (skip cut; run ASR + SRT on the uploaded clip as-is)
   - **Pipeline stepper** with 7 states: Idle · Cutting · Extracting Audio · Running ASR · Generating SRT · Shortening · Burning · Done. Active step animated, errors shown inline with retry.
   - **Output panel**: preview of cut video, download buttons for `clip.mp4`, `clip.mp3`, `subtitles.srt`, `clip_subbed.mp4`. In-browser player with SRT overlay preview before burn-in.
   - Log console (collapsible) showing ffmpeg stderr + ASR poll status.

## Technical design

### Stack additions
- `@ffmpeg/ffmpeg` + `@ffmpeg/util` (loaded from `public/ffmpeg/` — self-hosted core to avoid CORS/CDN issues; SharedArrayBuffer requires COOP/COEP headers set in `vite.config.ts` dev server and via response headers on the deployed worker).
- No new UI framework — reuse existing shadcn/Tailwind.

### Pipeline (all client-side except Stage 3)
- **Stage 1 – Cut**: `ffmpeg -ss <start> -to <end> -i input -c copy clip.mp4` (fast copy; falls back to re-encode if keyframe issues detected).
- **Stage 2 – Audio**: `ffmpeg -i clip.mp4 -vn -acodec libmp3lame -q:a 4 -ar 16000 -ac 1 clip.mp3`.
- **Stage 3 – LuxASR** (server): `POST /api/asr` — a TanStack server function receives the MP3 (multipart), forwards to LuxASR with `LUXASR_API_KEY`, polls the job, returns the timestamped JSON. Timeout + progress streamed back via SSE so the UI can show "polling…".
- **Stage 4 – SRT**: pure TS. Convert LuxASR segments → SRT with `HH:MM:SS,mmm` timestamps.
- **Stage 5 – Shorten/Split**: TS regex sentence splitter; groups into ≤2 sentences per cue; interpolates timestamps proportionally to character length within the source segment.
- **Stage 6 – Burn-in**: `ffmpeg -i clip.mp4 -vf "subtitles=subs.srt:force_style='FontName=Arial,FontSize=<n>,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,Bold=1,Outline=2,Alignment=2,MarginV=40'" -c:a copy clip_subbed.mp4`. Path escaping not needed (virtual FS uses POSIX paths).

### File layout
```
src/
  routes/
    index.tsx                    # Dashboard
    api/
      asr.ts                     # POST endpoint (multipart → LuxASR, SSE progress)
  lib/
    ffmpeg/
      client.ts                  # ffmpeg.wasm singleton loader
      cut.ts, extractAudio.ts, burnSubtitles.ts
    subtitles/
      parseTime.ts               # SS / MM:SS / HH:MM:SS → seconds
      luxasrToSrt.ts             # JSON → SRT
      shortenSrt.ts              # sentence-split + regroup
    asr.functions.ts             # createServerFn wrapper (optional; SSE uses raw route)
  components/
    dashboard/ (DropZone, CutForm, PipelineStepper, OutputPanel, LogConsole)
public/
  ffmpeg/ (ffmpeg-core.js, ffmpeg-core.wasm, ffmpeg-core.worker.js)
```

### Server function / route
`src/routes/api/asr.ts` — `POST` accepts `multipart/form-data` with the mp3, reads `process.env.LUXASR_API_KEY`, uploads to LuxASR, polls until complete or 5-min timeout, streams `{status, progress}` SSE events, and ends with `{result: <json>}`. Zod-validates the file (mime, size ≤ 100MB).

### State management
React state in the dashboard route; TanStack Query for the ASR request. Ffmpeg progress via `ffmpeg.on('progress', …)` piped to the stepper.

### Constraints surfaced to user
- Recommend clips ≤ 10 min / ≤ 500MB (ffmpeg.wasm RAM limit).
- Chrome/Edge/Firefox recommended (SharedArrayBuffer required).
- Tab must stay open while processing.

## Secrets
- `LUXASR_API_KEY` — will request via `add_secret` after plan approval. I'll also need the exact LuxASR base URL and endpoint paths (submit / poll / fetch-result) — I'll ask before wiring Stage 3 if the docs aren't standard.

## Design direction
Clean flat dashboard, dark-mode default with light toggle, using existing shadcn tokens. Single-column layout on mobile, two-column (controls left / preview+output right) on desktop. Pipeline stepper as a horizontal segmented bar with per-step icons.

## Out of scope (this pass)
- Live HLS stream recorder module
- Auth / job history / cloud storage
- Batch/multi-file processing

## Open question before build
Do you have the LuxASR API base URL and endpoint spec (submit/poll/fetch), or should I code against the public University of Luxembourg LuxASR API docs I can look up?
