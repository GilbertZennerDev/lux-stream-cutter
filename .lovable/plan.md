## Visual redesign: Midnight Indigo + JetBrains Mono / Work Sans + rich interactions

Goal: modern, reliable, smart, fast. Dark-first palette, engineering-grade typography, satisfying motion throughout.

### 1. Design tokens (`src/styles.css`)

Rewrite `:root` (dark-by-default) and `.dark` with the Midnight Indigo palette in oklch:

- `--background` deep near-black indigo `#0a0a1a`
- `--card` / `--popover` `#141432` with subtle glass
- `--muted` / `--secondary` `#1e1e5a` desaturated
- `--primary` electric indigo `#4f46e5` with `--primary-glow` `#818cf8`
- `--accent` cyan-mint `#22d3ee` for success/progress highlights
- `--border` `oklch(1 0 0 / 8%)`, `--ring` primary at 60%
- `--destructive` warm rose that reads on dark

Add new tokens used across the app:
- `--gradient-primary`, `--gradient-hero`, `--gradient-subtle`
- `--shadow-elegant`, `--shadow-glow`, `--shadow-inset`
- `--transition-spring` cubic-bezier for satisfying easing
- Light mode kept but re-tuned so it still reads (not the primary experience)

Also set base `html { color-scheme: dark }` and default the app to `.dark` in `__root.tsx`.

### 2. Typography

- Load JetBrains Mono (headings, numbers, timecodes) and Work Sans (body) via `<link>` tags in `src/routes/__root.tsx` head.
- In `@theme`: `--font-mono: "JetBrains Mono"`, `--font-sans: "Work Sans"`, `--font-display: "JetBrains Mono"`.
- Add utility classes `.font-display` for section titles, numeric readouts (durations, cue counts, progress %) use tabular mono.

### 3. Global effects and animation utilities

Add to `src/styles.css` (`@utility` + `@keyframes`):

- `.glass` — translucent card with `backdrop-blur-xl` + inset highlight border
- `.glow-primary` / `.glow-accent` — soft radial glow behind element
- `.shimmer` — animated gradient sweep for loading/progress
- `.press` — active:scale-[0.97] transition-spring (tactile button press)
- `.ring-focus` — animated primary ring on focus-visible
- Keyframes: `pulse-glow`, `shimmer`, `gradient-shift`, `float`, `success-pop`, `confetti-*`

Add page-level background: subtle animated radial gradients (two blurred indigo blobs, slow drift) behind the app — a `<div>` in `__root.tsx` with `pointer-events-none`.

### 4. Component polish (presentational only)

- **Buttons** (`src/components/ui/button.tsx`): add `premium` variant — gradient bg, shadow-glow, spring press, focus ring. Default variant gains subtle hover glow.
- **Cards** (`src/components/ui/card.tsx`): apply `.glass` look, gradient hairline border, hover lift.
- **Inputs**: focus ring uses `--primary-glow`, animated underline.
- **Progress**: shimmer overlay while running.
- **Toast/sonner**: slide-in with spring, colored left border by type.
- **Scrollbar**: thin styled scrollbar matching palette.
- **Sticky "Cut selected" action bar** (already in place): upgrade to `premium` variant with glow + shimmer while running.
- **Cue rows**: hover raises with `translate-y-[-1px]` and adds primary left-border accent; selected rows get inset glow.
- **Success moment**: on successful cut completion, fire a lightweight confetti burst (pure CSS/DOM, no dep) + success-pop on the resulting file card.

### 5. Page transitions

- Wrap route `<Outlet />` in a fade+slide transition (using existing `animate-fade-in` / `animate-scale-in`).
- Add a top progress bar that animates on route change / long-running ops.

### 6. Header / nav

- Sticky top nav with `.glass`, animated logo mark (small indigo → mint gradient shift), active link underline sweep.

### Files to edit

- `src/styles.css` — tokens, keyframes, utilities, base
- `src/routes/__root.tsx` — font links, dark default, ambient background, page transition wrapper
- `src/components/ui/button.tsx` — new `premium` variant + press/glow
- `src/components/ui/card.tsx` — glass + hover lift
- `src/components/ui/progress.tsx` — shimmer
- `src/components/ui/input.tsx`, `sonner.tsx` — polish
- `src/routes/index.tsx` — apply `premium` button to sticky Cut bar, confetti on success, mono numerals for counts/durations
- New: `src/components/fx/Confetti.tsx`, `src/components/fx/AmbientBackground.tsx`, `src/components/fx/RouteTransition.tsx`

### Not in scope

- No layout restructuring of existing pages beyond styling.
- No new dependencies (confetti done with plain DOM + CSS).
- No backend / logic changes.
