## Add HLS live-stream recorder

Add a **Recorder** module to the dashboard that captures an HLS live stream (e.g. `chamber_tv_hd`) directly in the browser and hands the resulting `.ts` file to the existing cutter/subtitler pipeline — no separate download/upload step needed (but still offered as fallback).

### UI

New collapsible card above the DropZone on `/`:

- URL input (prefilled with the Chamber TV playlist).
- **Start recording** / **Stop recording** buttons.
- Live status: elapsed time, segments captured, approximate MB written.
- On stop:
  - **"Use for cutting"** button → loads the recorded `.ts` blob into the existing pipeline as if it had been dropped in.
  - **Download .ts** button (fallback for manual re-upload).
- Small log line for fetch errors / CORS issues.

### How the recording works (browser-side)

1. Fetch the master `.m3u8`, pick the highest-bandwidth variant.
2. Poll the variant playlist every ~2 s.
3. For each new `#EXTINF` segment URL not yet seen, `fetch()` it, append the `Uint8Array` to an in-memory array of chunks.
4. Stop button → concatenate chunks into a single `Blob({ type: "video/mp2t" })` exposed as `recording.ts`.
5. Wrap as a `File` and pass to the existing `handleFile()` entry point so all current cut/ASR/burn logic works unchanged (`.ts` is already in the accepted list).

### CORS fallback

The Chamber TV origin likely doesn't send `Access-Control-Allow-Origin`, so direct browser fetch will fail. Add a thin proxy server route:

- `src/routes/api/hls-proxy.ts` — `GET ?url=<encoded>`; validates the URL host against an allow-list (`media02.webtvlive.eu`, `.chd.lu`, plus the exact host of the initial playlist), streams the upstream response back with permissive CORS. Handles both playlist (`.m3u8`) and segment (`.ts`) requests. Server runtime supports `fetch` + streaming `Response`, so no ffmpeg/native deps needed.
- Recorder rewrites segment URLs to route through the proxy.

### File layout additions

```
src/
  lib/hls/
    recorder.ts        # start/stop, playlist poll loop, segment fetcher
    parsePlaylist.ts   # minimal m3u8 parser (master + media)
  components/dashboard/
    RecorderCard.tsx   # UI
  routes/api/
    hls-proxy.ts       # CORS proxy w/ host allow-list
```

### Constraints surfaced to user

- Tab must stay open while recording (same as ffmpeg pipeline).
- Output is raw MPEG-TS; playback preview in-browser may not work for `.ts` in Safari — the "Use for cutting" path still works because ffmpeg.wasm handles TS.
- Long recordings grow linearly in RAM; recommend ≤ 30 min.

### Out of scope

- Scheduled/timed recordings.
- Simultaneous multiple streams.
- Muxing to MP4 during recording (kept as a later step via existing pipeline).
