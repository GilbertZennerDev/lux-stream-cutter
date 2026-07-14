import { useCallback, useRef } from "react";
import type { SubtitleLook } from "@/lib/ffmpeg/operations";
import { renderSubtitleStyle } from "@/lib/cutter/subtitleLookStyle";

interface Props {
  xPct: number;
  yPct: number;
  fontSize: number;
  outline: number;
  onChange: (x: number, y: number) => void;
  sample?: string;
  look?: SubtitleLook;
}

/**
 * A 16:9 preview box with a draggable subtitle sample.
 * xPct/yPct = centre of the text, in % of the box.
 */
export function SubtitlePreview({
  xPct, yPct, fontSize, outline, onChange, sample = "Beispill Ennertitlen",
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const updateFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const box = boxRef.current;
      if (!box) return;
      const r = box.getBoundingClientRect();
      const x = ((clientX - r.left) / r.width) * 100;
      const y = ((clientY - r.top) / r.height) * 100;
      onChange(
        Math.round(Math.max(0, Math.min(100, x))),
        Math.round(Math.max(0, Math.min(100, y))),
      );
    },
    [onChange],
  );

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

  // Approximate the ASS outline (in source-video px) by scaling to the preview box.
  // Assumes preview represents a ~720-tall video; good enough for a visual guide.
  const previewOutline = Math.max(0, outline);
  const shadow = previewOutline > 0
    ? Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        const dx = Math.cos(a) * previewOutline;
        const dy = Math.sin(a) * previewOutline;
        return `${dx.toFixed(2)}px ${dy.toFixed(2)}px 0 #000`;
      }).join(", ")
    : "none";

  return (
    <div
      ref={boxRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="relative rounded-md border bg-black aspect-video overflow-hidden touch-none cursor-crosshair select-none"
      role="application"
      aria-label="Subtitle position preview — drag to reposition"
    >
      <span
        className="absolute font-sans font-semibold text-white text-center leading-tight whitespace-nowrap pointer-events-none"
        style={{
          left: `${xPct}%`,
          top: `${yPct}%`,
          transform: "translate(-50%, -50%)",
          fontSize: `${fontSize}px`,
          textShadow: shadow,
        }}
      >
        {sample}
      </span>
      <div
        className="absolute h-px w-full bg-white/10 pointer-events-none"
        style={{ top: `${yPct}%` }}
      />
      <div
        className="absolute w-px h-full bg-white/10 pointer-events-none"
        style={{ left: `${xPct}%` }}
      />
    </div>
  );
}
