## Plan

1. **Fix the deployed worker recorder**
   - Update the worker HLS parser to read `AUDIO="..."` from variants and `#EXT-X-MEDIA:TYPE=AUDIO` renditions from the master playlist.
   - Update the worker recorder to poll the selected audio playlist in parallel with the video playlist.
   - Combine video and audio into one MPEG-TS output before upload, instead of uploading video-only chunks.

2. **Use server-side FFmpeg in the worker**
   - Add FFmpeg to the worker container.
   - Mux without re-encoding: video stream from the selected video playlist + audio stream from the audio playlist, preserving quality and keeping CPU use low.
   - Fail the recording chunk visibly if audio was expected but missing or muxing fails, rather than silently uploading a video-only file.

3. **Make audio status observable**
   - Add worker logs for: selected video variant, detected audio rendition, audio segment count/bytes, and mux success/failure.
   - Include enough context in failed recording rows so it is clear whether audio capture or muxing failed.

4. **Keep the browser recorder aligned**
   - Mirror parser fixes between `src/lib/hls/parsePlaylist.ts` and `worker/src/parsePlaylist.mjs` so manual browser recordings and scheduled worker recordings interpret HLS audio the same way.

5. **Verify with the actual Chamber TV playlist**
   - Record a short sample from the current playlist.
   - Inspect it with `ffprobe` to confirm both video and audio streams are present.
   - Confirm the resulting `.ts` should play with sound in VLC and be usable by Cutter.