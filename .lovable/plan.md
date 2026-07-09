## Plan to fix Auto-sync for good

### What I found
- **Medium tier currently tries GPU lip-sync** when WebGL2 exists. That can be unstable on many machines and can stall during frame analysis.
- **Frame analysis uses repeated video seeks**, which is fragile in Chromium and can get stuck or read stale frames.
- **The detector correlates raw mouth opening to raw audio volume**, which is noisy and often returns a weak or wrong offset.
- **After auto-detect, the preview shown is still the old analysed clip**, not a newly generated clip with the detected offset applied, so it can look like Auto-sync did nothing.
- **There is no confidence gate / validation pass**, so bad correlations may be accepted as success.

### Implementation
1. **Make Medium hardware safer**
   - Change Medium tier lip-sync to CPU by default.
   - Keep GPU for High tier only, and still allow GPU fallback when model creation fails.

2. **Replace fragile seek-per-frame sampling**
   - Sample video during muted playback with `requestVideoFrameCallback` when available.
   - Keep a seek-based fallback only if playback sampling cannot run.
   - Add internal timeouts so Auto-sync fails clearly instead of appearing frozen.

3. **Improve the sync signal**
   - Convert mouth aperture into a mouth-motion/onset signal instead of raw opening.
   - Smooth and normalize audio RMS, then correlate speech-energy changes against mouth-motion changes.
   - Search offsets across the configured lag window and reject flat/noisy signals.

4. **Fix result application and preview**
   - After detection computes `nextOffset`, generate a fresh preview using that `nextOffset`.
   - Update the status/log text so the user can see analysed offset, confidence, face coverage, and final applied preview.

5. **Add validation guardrails**
   - Require minimum face coverage, mouth movement, audio peak, and correlation confidence.
   - If confidence is too low, show a clear message to pick another cue rather than applying a bad offset.

6. **Verify**
   - Run a browser check that opening the calibrator no longer stalls at 5%.
   - Confirm Auto-detect reaches frame analysis progress, reports a result or actionable failure, and displays a regenerated preview at the new offset.