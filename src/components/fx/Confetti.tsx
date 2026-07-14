import { useEffect, useState } from "react";

interface Piece {
  id: number;
  left: number;
  dx: number;
  color: string;
  size: number;
  delay: number;
  duration: number;
  rotate: number;
}

const COLORS = [
  "oklch(0.58 0.22 275)",
  "oklch(0.74 0.16 275)",
  "oklch(0.82 0.15 200)",
  "oklch(0.72 0.20 145)",
  "oklch(0.85 0.18 90)",
];

/**
 * Mount once near the app root. Fire a burst by dispatching
 *   window.dispatchEvent(new CustomEvent("lux:confetti"))
 * Pure DOM/CSS — no dependencies.
 */
export function Confetti() {
  const [bursts, setBursts] = useState<Piece[][]>([]);

  useEffect(() => {
    const handler = () => {
      const pieces: Piece[] = Array.from({ length: 80 }, (_, i) => ({
        id: Date.now() + i,
        left: Math.random() * 100,
        dx: (Math.random() - 0.5) * 400,
        color: COLORS[i % COLORS.length],
        size: 6 + Math.random() * 8,
        delay: Math.random() * 150,
        duration: 1600 + Math.random() * 1400,
        rotate: 360 + Math.random() * 720,
      }));
      setBursts((prev) => [...prev, pieces]);
      const maxLife = 3200;
      setTimeout(() => {
        setBursts((prev) => prev.slice(1));
      }, maxLife);
    };
    window.addEventListener("lux:confetti", handler);
    return () => window.removeEventListener("lux:confetti", handler);
  }, []);

  if (bursts.length === 0) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[9999] overflow-hidden">
      {bursts.map((pieces, bi) => (
        <div key={bi} className="absolute inset-0">
          {pieces.map((p) => (
            <span
              key={p.id}
              style={{
                position: "absolute",
                left: `${p.left}%`,
                top: 0,
                width: `${p.size}px`,
                height: `${p.size * 0.4}px`,
                background: p.color,
                borderRadius: "1px",
                animation: `confetti-fall ${p.duration}ms cubic-bezier(0.2, 0.6, 0.4, 1) ${p.delay}ms forwards`,
                // @ts-expect-error CSS custom props
                "--dx": `${p.dx}px`,
                "--r": `${p.rotate}deg`,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function fireConfetti() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("lux:confetti"));
  }
}
