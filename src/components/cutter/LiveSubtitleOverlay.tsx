import { useCallback, useEffect, useRef, useState } from "react";
import type { SrtCue } from "@/lib/subtitles/luxasrToSrt";

interface Props {
  src: string;
  xPct: number;
  yPct: number;
  fontSize: number; // in ASS/source-video px — scaled to preview width
  outline: number;  // px
  cues?: SrtCue[];
  defaultSample?: string;
  onChange: (x: number, y: number) => void;
  onTimeUpdate?: (t: number) => void;
  /** Optional external ref for parent-controlled seeking. */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}

/**
 * Real source-video preview with a live, draggable subtitle overlay.
 *
 * Compared to the abstract 16:9 <SubtitlePreview>, this shows the user
 * exactly what the burned output will look like: the actual footage plays
 * underneath and the caption for the current timestamp appears on top,
 * repositionable by drag or slider.
 */
export function LiveSubtitleOverlay({
  src, xPct, yPct, fontSize, outline, cues, defaultSample = "Beispill Ennertitlen", onChange, onTimeUpdate, videoRef,
}: Props) {
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const videoElRef = videoRef ?? internalVideoRef;
  const boxRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [boxWidth, setBoxWidth] = useState(640);

  // Track the preview width so we can rescale the ASS font-size (which is
  // in source-video pixels) to the preview size for a faithful WYSIWYG.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBoxWidth(box.clientWidth));
    ro.observe(box);
    setBoxWidth(box.clientWidth);
    return () => ro.disconnect();
  }, []);

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
    // Only drag when the pointer is on the overlay layer, not the video controls.
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

  // Pick the cue that covers the current time (binary search would be
  // overkill — typical projects have <500 cues).
  const activeCue = cues?.find((c) => currentTime >= c.start && currentTime <= c.end);
  const text = activeCue?.text?.trim() || defaultSample;
  const activeX = activeCue?.xPct ?? xPct;
  const activeY = activeCue?.yPct ?? yPct;

  // Scale the ASS font-size (assumed authored against a 720-tall source video
  // in cuesToAss) into preview pixels. We map by width so wide overlays feel
  // right regardless of aspect. ASS default PlayResX is ~1280 in cuesToAss.
  const scale = boxWidth / 1280;
  const previewFont = Math.max(8, Math.round(fontSize * scale));
  const previewOutline = Math.max(0, outline * scale);
  const shadow = previewOutline > 0
    ? Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        const dx = Math.cos(a) * previewOutline;
        const dy = Math.sin(a) * previewOutline;
        return `${dx.toFixed(2)}px ${dy.toFixed(2)}px 0 #000`;
      }).join(", ")
    : "none";

  return (
    <div ref={boxRef} className="relative rounded-md border bg-black overflow-hidden aspect-video select-none">
      <video
        ref={videoElRef}
        src={src}
        controls
        muted
        playsInline
        preload="metadata"
        className="absolute inset-0 w-full h-full"
        onTimeUpdate={(e) => {
          const t = (e.currentTarget as HTMLVideoElement).currentTime;
          setCurrentTime(t);
          onTimeUpdate?.(t);
        }}
      />
      {/* Draggable overlay — sits above the video but leaves the bottom
          control bar clickable. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="absolute inset-0 cursor-crosshair touch-none"
        style={{ bottom: 40 /* clear native <video> controls */ }}
        role="application"
        aria-label="Drag to reposition subtitle"
      >
        <span
          className="absolute font-sans font-semibold text-white text-center leading-tight whitespace-pre-line pointer-events-none px-2"
          style={{
            left: `${activeX}%`,
            top: `${activeY}%`,
            transform: "translate(-50%, -50%)",
            fontSize: `${previewFont}px`,
            textShadow: shadow,
            maxWidth: "90%",
          }}
        >
          {text}
        </span>
        <div className="absolute h-px w-full bg-white/10 pointer-events-none" style={{ top: `${activeY}%` }} />
        <div className="absolute w-px h-full bg-white/10 pointer-events-none" style={{ left: `${activeX}%` }} />
        {activeCue && (
          <div className="absolute top-1 left-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/80 text-primary-foreground pointer-events-none">
            cue #{activeCue.index}
          </div>
        )}
      </div>
    </div>
  );
}
