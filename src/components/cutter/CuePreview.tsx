import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, LockKeyhole } from "lucide-react";
import { getFrameAt } from "@/lib/cutter/frameSnapshots";
import { cn } from "@/lib/utils";
import type { SubtitleLook } from "@/lib/ffmpeg/operations";
import { renderSubtitleStyle } from "@/lib/cutter/subtitleLookStyle";

export type LockAxis = "free" | "x" | "y";

interface Props {
  videoSrc: string;
  /** Timestamp of the frame to snapshot (seconds). */
  time: number;
  xPct: number;
  yPct: number;
  fontSize: number;
  outline: number;
  text: string;
  lockAxis?: LockAxis;
  onChange: (patch: { xPct?: number; yPct?: number }) => void;
  /** Inline (list-row) or large (dialog). */
  size?: "inline" | "large";
  /**
   * Actual source video width in px. Used to scale ASS `fontSize`/`outline`
   * (which are in video pixels) into preview pixels so the overlay matches
   * the burned-in output. Defaults to 1280 for backward compat.
   */
  videoWidth?: number;
  /** If false, defers snapshot until the element is visible. */
  eager?: boolean;
  /** Colour/effect look — mirrors the burned output. */
  look?: SubtitleLook;
}

/**
 * A single video frame snapshot with a draggable subtitle overlay, styled to
 * match LiveSubtitleOverlay so what the user sees here matches the burn-in.
 * Snapshots are lazy (IntersectionObserver) so a 200-cue list doesn't spawn
 * 200 decoders on mount.
 */
export function CuePreview({
  videoSrc, time, xPct, yPct, fontSize, outline, text, lockAxis = "free", onChange,
  size = "inline", videoWidth = 1280, eager = false, look,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(eager);
  const [boxWidth, setBoxWidth] = useState(size === "large" ? 900 : 320);
  const [error, setError] = useState<string | null>(null);
  const draggingRef = useRef(false);

  // Lazy-load when in view.
  useEffect(() => {
    if (eager) return;
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) { setVisible(true); io.disconnect(); break; }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [eager]);

  // Fetch the frame when we become visible / the target time changes.
  useEffect(() => {
    if (!visible || !videoSrc) return;
    let cancelled = false;
    setError(null);
    getFrameAt(videoSrc, time, size === "large" ? 1280 : 480)
      .then((url) => { if (!cancelled) setFrameUrl(url); })
      .catch((e: unknown) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [visible, videoSrc, time, size]);

  // Track box width to scale ASS font-size into preview pixels (matches
  // LiveSubtitleOverlay's PlayResX=1280 assumption from cuesToAss).
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBoxWidth(box.clientWidth));
    ro.observe(box);
    setBoxWidth(box.clientWidth);
    return () => ro.disconnect();
  }, []);

  const updateFromEvent = useCallback((clientX: number, clientY: number) => {
    const box = boxRef.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    const x = Math.round(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
    const y = Math.round(Math.max(0, Math.min(100, ((clientY - r.top) / r.height) * 100)));
    const patch: { xPct?: number; yPct?: number } = {};
    if (lockAxis !== "y") patch.xPct = x;
    if (lockAxis !== "x") patch.yPct = y;
    if (patch.xPct !== undefined || patch.yPct !== undefined) onChange(patch);
  }, [lockAxis, onChange]);

  const onPointerDown = (e: React.PointerEvent) => {
    draggingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    updateFromEvent(e.clientX, e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    updateFromEvent(e.clientX, e.clientY);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    draggingRef.current = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  // Scale ASS px → preview px, mirroring LiveSubtitleOverlay.
  const scale = boxWidth / Math.max(1, videoWidth);
  const previewFont = Math.max(8, Math.round(fontSize * scale));
  const previewOutline = Math.max(0, outline * scale);
  const previewShadow = Math.max(0, (look?.shadow ?? 0) * scale);
  const { textStyle, boxStyle } = renderSubtitleStyle(look, previewOutline, previewShadow);

  const displayText = (text || "").trim() || "…";

  const cursorClass =
    lockAxis === "x" ? "cursor-ew-resize" :
    lockAxis === "y" ? "cursor-ns-resize" :
    "cursor-crosshair";

  return (
    <div
      ref={boxRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "relative rounded-md border bg-black overflow-hidden aspect-video select-none touch-none",
        cursorClass,
      )}
      role="application"
      aria-label="Drag to reposition subtitle"
    >
      {frameUrl ? (
        <img src={frameUrl} alt="" className="absolute inset-0 w-full h-full object-cover pointer-events-none" />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-muted-foreground text-[11px]">
          {error ? (
            <span className="text-destructive">frame unavailable</span>
          ) : visible ? (
            <span className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> loading frame…</span>
          ) : null}
        </div>
      )}

      <div
        className="absolute text-center leading-tight whitespace-pre-line pointer-events-none px-2 font-sans"
        style={{
          left: `${xPct}%`,
          top: `${yPct}%`,
          transform: "translate(-50%, -50%)",
          fontSize: `${previewFont}px`,
          maxWidth: "92%",
        }}
      >
        {boxStyle ? (
          <span style={{ ...boxStyle, ...textStyle }}>{displayText}</span>
        ) : (
          <span style={textStyle}>{displayText}</span>
        )}
      </div>
      <div className="absolute h-px w-full bg-white/10 pointer-events-none" style={{ top: `${yPct}%` }} />
      <div className="absolute w-px h-full bg-white/10 pointer-events-none" style={{ left: `${xPct}%` }} />

      {lockAxis !== "free" && (
        <div className="absolute top-1 right-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/60 text-white/90 flex items-center gap-1 pointer-events-none">
          <LockKeyhole className="h-2.5 w-2.5" />
          {lockAxis === "x" ? "X only" : "Y only"}
        </div>
      )}
    </div>
  );
}
