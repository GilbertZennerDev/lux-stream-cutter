/**
 * Full-viewport ambient background: two slow-drifting indigo/mint blobs
 * plus a subtle grid. Purely decorative, pointer-events-none.
 */
export function AmbientBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      {/* Base gradient wash */}
      <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_10%_-10%,oklch(0.58_0.22_275/0.35),transparent_60%),radial-gradient(1000px_500px_at_100%_10%,oklch(0.82_0.15_200/0.18),transparent_60%)]" />
      {/* Indigo blob */}
      <div className="absolute -top-40 -left-40 h-[560px] w-[560px] rounded-full bg-primary/25 blur-[120px] animate-float" />
      {/* Mint blob */}
      <div className="absolute top-1/2 -right-40 h-[520px] w-[520px] rounded-full bg-accent/20 blur-[120px] animate-float-alt" />
      {/* Subtle grid */}
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "linear-gradient(oklch(1 0 0 / 0.5) 1px, transparent 1px), linear-gradient(90deg, oklch(1 0 0 / 0.5) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage:
            "radial-gradient(ellipse at center, black 40%, transparent 75%)",
        }}
      />
    </div>
  );
}
