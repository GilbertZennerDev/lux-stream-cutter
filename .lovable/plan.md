## Plan: make `clip_subbed.mp4` match the previews, with real verification

1. **Treat this as a pipeline bug, not just a font bug**
   - The left-side transcript/global previews are browser overlays using CSS fonts.
   - `clip_subbed.mp4` is a separate FFmpeg output, and the current code only checks that an MP4 file was created — not that subtitles are actually visible in that MP4.
   - I will fix that gap directly.

2. **Create one shared burn request for both export paths**
   - Normalize the exact cue list, timestamps, per-cue positions, global position, font size, outline, video dimensions, and selected font into one object before burning.
   - Use that same object for:
     - full pipeline burn-in
     - “Cut selected” burn-in
   - Add logs that show the exact cue count, first cue time, output duration basis, selected font family, and whether an uploaded font file URL is available.

3. **Verify the actual burned MP4 pixels**
   - After FFmpeg creates `clip_subbed.mp4`, sample a frame from the output at the midpoint of the first subtitle cue.
   - Sample the matching frame from the plain cut clip.
   - Compare the subtitle region pixels to confirm the burned output visibly differs from the plain clip where the caption should be.
   - If there is no visible subtitle difference, do not report success and do not silently return the bad MP4.

4. **Retry with alternate burn pipelines only when verification fails**
   - First try the normal custom-font libass burn.
   - If the output MP4 has no visible subtitles, retry with:
     - subtitles filter before/after scaling as appropriate
     - safer explicit video/audio stream handling
     - the built-in Noto style as a diagnostic fallback
   - Keep `drawtext` disabled because it caused the WASM memory crash.

5. **Make failures actionable in the UI log**
   - Add logs like:
     - `[BURN] ASS cues: 12, first visible at 0.42s`
     - `[BURN] Selected font row found: Whitney Book (.otf)`
     - `[BURN] MP4 created, verifying subtitle pixels…`
     - `[BURN] Verification failed: output frame matches plain clip`
     - `[BURN] Retrying with fallback burn graph…`
   - If all attempts fail, show a clear pipeline error instead of giving a subtitle-less `clip_subbed.mp4`.

6. **Validate without spending ASR credits**
   - Use existing cues/SRT state and local/generated test media where possible.
   - Do not re-run LuxASR just to test burn-in.
   - Verification will focus on whether `clip_subbed.mp4` visibly contains captions, not whether transcription works.

## Technical focus

- Main files to update after approval:
  - `src/lib/ffmpeg/operations.ts`
  - `src/routes/index.tsx`
- The key change is: **success = burned subtitles are visible in the produced MP4**, not merely “FFmpeg returned an MP4 file.”