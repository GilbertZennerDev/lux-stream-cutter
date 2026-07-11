## Plan: fix `clip_subbed.mp4` burn-in by removing the broken verification path and making the burn pipeline deterministic

1. **Fix the immediate verifier crash**
   - Replace the invalid verification crop filter syntax (`crop:w=...`) with FFmpeg-compatible syntax (`crop=...:...:...:...`).
   - Stop reporting `mean diff 0.00` after the verifier itself failed; verification failures and verifier-extraction failures should be separate log messages.

2. **Stop using the source video as the verifier baseline when it cannot match the burned output**
   - The current comparison extracts the reference crop from `burn_input` with the output scale applied, then compares it to `burned.mp4` without guaranteeing same seek timing, dimensions, color path, or frame availability.
   - Change verification to compare two frames from the same generated output:
     - one frame inside the first subtitle cue region
     - one nearby frame outside any subtitle cue, or a nearby subtitle-free crop/time
   - This verifies visible subtitle pixels without depending on a separate plain input decode path.

3. **Make cue timing match the clip being burned**
   - For full pipeline, keep cue times only if the clip starts at zero after cutting.
   - For selected-cue export, keep the current remap-to-zero logic.
   - Add a guard/log that the first burn cue starts within the actual clip duration; if not, fail before FFmpeg runs with a clear pipeline error.

4. **Simplify burn attempts to avoid WASM memory crashes**
   - Remove unused/fragile `drawtext` fallback code paths from `operations.ts`; keep libass subtitles only.
   - Do not retry many complex graph/font combinations after the FFmpeg worker shows memory instability.
   - Try a small, deterministic set:
     1. subtitle burn at output dimensions
     2. scale then subtitle burn only when downscaling is requested
     3. built-in Noto fallback only if the selected uploaded font fails

5. **Make metadata reading robust**
   - Replace `getVideoDimensions(video)` browser metadata dependency in the burn request with a fallback:
     - try browser metadata first
     - if it fails, derive dimensions with FFmpeg probing/snapshot fallback or use the known source dimensions already cached in state
   - This prevents `Could not read video metadata` from aborting burns when the Blob is valid but the browser cannot load metadata quickly.

6. **Improve logs so the next failure is actionable**
   - Log: clip duration basis, first cue time range, ASS PlayRes, selected font file availability, chosen burn graph, and verification sample times.
   - If the output has no visible subtitles, say whether the issue is cue timing, subtitle rendering, or verifier extraction — not just “verification failed.”

## Technical files to update

- `src/lib/ffmpeg/operations.ts`
  - crop filter generation
  - verification extraction/comparison
  - burn attempt loop
  - metadata/duration helpers if needed
- `src/routes/index.tsx`
  - cue timing/dimension guards in `burnClipWithCurrentSettings`
  - use cached dimensions as a fallback

## Validation

- Reproduce with existing cues/local clip only; do not re-run LuxASR.
- Verify that `clip_subbed.mp4` is only exposed after subtitles are visibly detected.
- Confirm the built-in Noto path still works and uploaded `.otf` no longer gets hidden by a pipeline/verification bug.