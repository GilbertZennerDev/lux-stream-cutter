## Diagnosis

The latest 10-minute recording is ~286 MB, while earlier 10-minute files are ~72 MB. That size jump strongly suggests the current deployed worker is capturing a higher-bitrate video variant, but the uploaded file is still video-only. The app currently records split HLS audio only if the worker that is actually deployed includes the new audio polling + FFmpeg muxing code and is restarted/redeployed with FFmpeg available.

## Plan

1. **Prove where audio is lost**
   - Download the newest recording from storage using the existing signed-url flow.
   - Run `ffprobe` on the actual uploaded `.ts` file to confirm whether it contains only video or video+audio.
   - Inspect the live Chamber TV master playlist and selected variant/audio rendition at the same time.

2. **Make the worker impossible to silently upload video-only when audio is declared**
   - Keep selecting the video variant from the master playlist.
   - Detect the matching `AUDIO="..."` rendition from `#EXT-X-MEDIA:TYPE=AUDIO`.
   - If the master declares external audio and no audio segments are captured, mark the recording as failed instead of uploading a ready video-only `.ts`.
   - Add explicit worker logs for selected variant, audio playlist URL, video segment count/bytes, audio segment count/bytes, and mux result.

3. **Fix muxing robustness**
   - Use FFmpeg in the worker container to mux video + audio without re-encoding.
   - Validate the muxed output with `ffprobe` before upload; if no audio stream is present, fail the chunk visibly.
   - Avoid the current false-success path where a ready recording can still be silent.

4. **Expose audio status in the app**
   - Store recording audio status/error detail in the recording row or existing error/status fields.
   - Show clear status in the recordings UI so a silent file is never presented as a normal ready recording.

5. **Verify against the real stream**
   - Record a short worker sample locally using the same playlist URL.
   - Run `ffprobe` and confirm `h264` video plus `aac` audio.
   - After deployment, check the next uploaded recording from storage with `ffprobe` before calling this fixed.

## Important deployment note

Code changes alone will not repair the already-uploaded silent recordings. The worker service also must be redeployed/restarted so it runs the fixed image with FFmpeg installed. Existing silent `.ts` files cannot recover missing audio unless the original audio segments are still available from the live stream archive, which is unlikely for this HLS source.