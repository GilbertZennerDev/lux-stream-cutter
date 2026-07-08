## Plan

1. **Stop using `filter_complex` for cutting**
   - Replace the multi-segment `trim/atrim/concat` filter graph in `cutAndConcat` with a simpler two-step pipeline:
     - cut each segment into its own temporary MP4 file
     - concatenate those files with FFmpeg’s concat demuxer
   - This avoids the browser Wasm FS crash path that produces `ErrnoError: FS error`.

2. **Make single-segment cuts safer too**
   - Keep the fast stream-copy path for normal MP4 input.
   - If it fails or no output file is produced, automatically fall back to re-encoding.
   - For transport-stream-derived input, prefer safer seek/re-encode behavior instead of depending on a fragile copy result.

3. **Add proper FFmpeg filesystem hygiene**
   - Use unique temp filenames per run so stale files do not collide with previous failed jobs.
   - Delete all temp segment files, concat list files, input files, and output files in `finally` blocks.
   - Treat missing output after `ffmpeg.exec()` as a real failure with a clearer message instead of surfacing raw `ErrnoError`.

4. **Fix `.ts` preparation assumptions**
   - Keep the existing TS-to-MP4 remux preview path, but do not rely on it as the only protection.
   - If cutting still receives a TS/remuxed stream that fails copy, use the segment re-encode fallback automatically.

5. **Verify the real user flow**
   - Typecheck the edited files.
   - Run the cutter flow in the browser with a small generated sample video, including multiple cut ranges, and confirm the output clip is created instead of showing `Pipeline failed`.