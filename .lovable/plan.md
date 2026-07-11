
# Declutter the Cutter — keep only what users touch every session

## My opinion

Agreed with your read. Since we shipped the **live subtitle overlay** and **cue-driven cutting** (users pick sentences in the transcript and hit "Cut selected"), the old Segment editor and the "Full pipeline / Just cut / Subs only" mode tabs are 95% dead weight. `Burn subtitles` and `Low-performance mode` are set-once-and-forget for almost everyone — they don't belong at the top level.

But I don't want to **delete** them. Three real cases still need them:
- Someone wants a raw trim with no transcription → `Just cut` + segments.
- Someone wants an `.srt` only, no re-encode → `Subs only` + `Burn = off`.
- A weak Mac that ffmpeg.wasm chokes on → `Low-performance mode`.

So the right move is **hide, not remove** — collapse them into a single "Advanced" disclosure that's closed by default. The main surface becomes just: source → transcript list → live preview → Cut selected.

## What the Cutter shows by default (after)

```text
┌─ Source (upload / recording chip / live snapshot)
├─ Live video + draggable subtitle overlay
├─ Transcript list  ── [ Cut selected ]  [ Download SRT ]
├─ Subtitle look    (position sliders, font size, outline)
└─ ▸ Advanced       (closed)
```

Nothing else visible until the user opens Advanced.

## What moves into `▸ Advanced` (single `<details>` / Collapsible)

- Mode tabs: `Full pipeline` / `Just cut` / `Subs only`
- Segment editor (Segment N, Start / End, Preview start/end, + Add segment, total duration)
- `Burn subtitles into video` switch
- `Low-performance mode` switch
- Audio offset slider + `SyncCalibrator` (already niche)
- `Max sentences / cue` and `Max chars / cue` (rarely re-tuned)
- `PerfSelector` status (auto-detected tier — informational)

Keep in the main body:
- Subtitle position (X/Y), font size, outline — they're what the live overlay reacts to, so they belong next to it.

## Behaviour when Advanced is hidden

Defaults stay exactly as they are today, so hiding the UI doesn't change any output:
- `mode = "full"` — the "Cut selected" button already ignores the segment editor and uses the picked cues (`runCutSelected` path around line 1141), so the segment array being untouched is fine.
- `burnIn = true`
- `lowPerf = false` (auto `perf.lowPerf` still applies via `effLowPerf`)
- `maxSentences = 2`, `maxChars = 90`, `audioOffsetSec = 0`

The "Run" button that consumes the segment editor stays reachable only when Advanced is open, which matches its actual use.

## Small visual cue that Advanced exists

A muted one-liner under the disclosure trigger: *"Segment editor, mode, burn-in, performance, sync"*. Users who need it will find it; users who don't get a much calmer page.

## Files touched (UI-only, no logic changes)

- `src/routes/index.tsx`
  - Wrap the current "2. Cut & options" `Card` (mode Tabs + segment editor block) in a `<Collapsible>` under an Advanced trigger.
  - Move the two `Switch` rows (`burn`, `lowperf`), the audio-offset slider + `SyncCalibrator`, `PerfSelector`, and the `maxSentences` / `maxChars` inputs into the same Advanced Collapsible (keep subtitle position/size/outline in the main "Subtitle look" card).
  - Remove the numbered `2.` heading; renumber the remaining section labels or drop the numbering entirely (numbering implies a required order that no longer exists).
- No changes to state, defaults, or the pipeline functions. `mode`, `burnIn`, `lowPerf`, `segments`, etc. keep their current defaults so behaviour is identical for a user who never opens Advanced.

## Explicitly not doing

- Not deleting any feature — every hidden control is still reachable in one click.
- No changes to Recordings, Premiere, Studio, worker, ffmpeg, or LuxASR.
- No visual redesign beyond the disclosure — same colors, same components.
