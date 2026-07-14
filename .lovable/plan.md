
# Cutter QoL Pass + Subtitle Colors & Effects

Two tracks: (1) practical quality-of-life fixes that address the friction I can see in the current UI, and (2) a real "Subtitle look" upgrade with colors and effects that actually reach the burned MP4.

## Track 1 — Quality of life

Focused, high-value only. Nothing speculative.

### A. Cut selected: the primary action deserves a clearer home
Today "Cut selected (N)" sits inside a header strip above the transcript list; it's the main workflow button but visually reads like a secondary action next to "Select all / Clear".
- Promote it to a sticky action bar at the bottom of the transcript card while cues exist, with: cue count · total selected duration · "Cut selected" · "Cut + burn subs" split.
- Show estimated output length ("→ 0:47") so users know before they cut.

### B. Transcript list: keyboard + bulk ergonomics
- `Space` toggles the focused cue; `↑/↓` moves focus; `Enter` seeks the preview to it. Right now every toggle is a mouse click.
- Shift-click a cue to range-select between it and the last-clicked one.
- "Invert selection" and "Select from here to end" in the header menu.
- Show a small waveform-free duration badge per cue (`0:03`) — helpful when deciding whether to trim.

### C. Preview scrubbing that follows the transcript
- Clicking a cue timestamp already seeks `startVideoRef`, but that video is hidden inside the collapsed Advanced panel. Make the main `LiveSubtitleOverlay` the single source of truth: clicking a cue seeks it, and the currently-playing cue is highlighted / auto-scrolled in the list.
- Add `J K L` (rewind / pause / forward) and `,` `.` (nudge ±1 frame ≈ 40 ms) on the main preview.

### D. Undo for destructive edits
Split, Join, Re-ASR, "Reset session", "Apply position to all" all mutate state irreversibly. Add a lightweight undo stack (last ~20 mutations) with `Cmd/Ctrl+Z` and a small toast action ("Undone"). Covers the common "oops I merged the wrong two blocks" case.

### E. Reduce first-render noise
- Fold "Source video" and "Subtitle look" into a single left rail; the second card is huge and pushes the transcript below the fold on 1080p.
- The "Fine-tune default position & outline" collapsible currently duplicates the sliders that live in the per-cue drawer. Keep only the drag preview + a compact "X · Y · outline" readout in the collapsed state; move the sliders behind the toggle only.
- Move the `Font size` slider next to the color/effect controls (see Track 2) so all "look" controls live together.

### F. Outputs card: sensible defaults + naming
- Auto-download `clip_subbed.mp4` when the pipeline finishes (opt-out in a small "Auto-download when done" toggle, remembered per session).
- Name outputs after the source: `<sourceTitle>__cut.mp4`, `<sourceTitle>__subs.srt`, `<sourceTitle>__subbed.mp4`. Today they're all generic `clip.mp4`.
- Copy-SRT-to-clipboard button next to Download SRT.

### G. Progress feedback
- Pipeline stepper shows a percent inside the active pill (e.g. "Burn-in 62%"), so users don't have to look at the thin bar underneath.
- On failures, keep the "Retry from this step" button next to the error alert (cut → burn is the common re-run).

### H. Small wins
- Persist `Auto-download`, `Lock axis`, output resolution, and burn toggle in `cutterSession` (some already are — audit and finish).
- Drag-and-drop a file onto the whole page, not just the dropzone label.
- Show the actual source resolution/duration under the file name once known (we already fetch `sourceDims` — surface it).

## Track 2 — Subtitle colors & effects (reaches the burned output)

Right now the only "look" controls are font size, outline width and position. Extend the model end-to-end.

### New controls in "Subtitle look"
- **Primary color** — color swatch + eyedropper (native `<input type="color">`). Default white.
- **Outline color** — default black.
- **Shadow** — toggle + intensity (0–4 px) + shadow color (default 60% black).
- **Background box** — toggle "Boxed style" (ASS `BorderStyle=3`) with box color + padding intensity. Useful for talking-head / news captions.
- **Bold / Italic** — two small toggles.
- **Style presets** — four one-click presets so 90% of users skip the fiddly controls:
  1. *Classic* — white text, black outline (current default).
  2. *News lower-third* — white text on solid black box.
  3. *YouTube pop* — bold yellow text, black outline, subtle shadow.
  4. *Cinema* — thin cream text, no outline, soft shadow.
- **Per-cue emphasis** — small color swatch on the per-cue drawer to override the primary color for one block (e.g. highlight a punchline). Falls back to the global setting when unset.

### Effects (per-cue, optional, animation via ASS override tags)
Kept small and safe — every effect must render correctly in libass and stay legible.
- **Fade in/out** — global toggle + duration slider (0–500 ms). Emitted as `{\fad(in,out)}`.
- **Pop-in** — scale from 80% → 100% on entry using `\t(0,120,\fscx100\fscy100)` after `\fscx80\fscy80`. Good for shorts.
- **Typewriter** — reveal letters over the cue's first N ms (`\k`-style). Off by default; adds size to the ASS but works.
- **Karaoke highlight** — for cues where the user has typed inline `|` markers, wraps segments in `\kf` so the active word paints. Optional; only exposed if any cue contains `|`.

### Wiring
- Extend `SubtitleStyle` in `src/lib/ffmpeg/operations.ts` with `primaryColor`, `outlineColor`, `shadowColor`, `shadow`, `bold`, `italic`, `borderStyle`, `boxColor`, `effect`, `effectMs`. Convert hex → `&HAABBGGRR` in an existing helper.
- Extend `SrtCue` with optional `color?: string` and `effect?: string` overrides; propagate through `luxasrToSrt`, `shortenCues`, `cutFromSelectedCues`, per-cue drawer, and `CuePositionDialog`.
- Update `cuesToAss` to emit the extended `Style: Default` line and per-cue `{\c&H..&\3c&H..&\fad(..)}` override blocks when set.
- Update `LiveSubtitleOverlay`, `CuePreview`, `SubtitlePreview` to render the same color/shadow/box so WYSIWYG holds.
- Persist all new values in `CutterSessionState` (bump the version and provide a migration that fills defaults).

## Not doing (intentionally out of scope)
- Font selection changes (per your instruction).
- Timeline scrubber / waveform view — big lift for uncertain payoff.
- Emoji / RTL-specific handling.
- Server-side rendering; everything stays in ffmpeg.wasm.

## Suggested build order
1. Track 2 data model + `cuesToAss` extension + previews (biggest visible payoff, unlocks presets).
2. Presets + color pickers UI in "Subtitle look".
3. Track 1 A/B/C (sticky Cut bar, keyboard nav, preview-as-source-of-truth).
4. Track 1 D (undo), F (auto-download + naming), G (progress %).
5. Track 1 E (layout tidy), H (persistence + page-wide drop).
