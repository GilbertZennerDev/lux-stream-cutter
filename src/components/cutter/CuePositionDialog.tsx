import { useEffect, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { LockKeyhole, MoveHorizontal, MoveVertical, RotateCcw, ArrowDownToLine, ArrowRightToLine } from "lucide-react";
import type { SrtCue } from "@/lib/subtitles/luxasrToSrt";
import { CuePreview, type LockAxis } from "./CuePreview";
import { formatSeconds } from "@/lib/subtitles/parseTime";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  cue: SrtCue | null;
  videoSrc: string | null;
  defaultX: number;
  defaultY: number;
  fontSize: number;
  outline: number;
  videoWidth?: number;
  lockAxis: LockAxis;
  onLockAxisChange: (v: LockAxis) => void;
  onChange: (patch: { xPct?: number; yPct?: number }) => void;
  onReset: () => void;
  onApplyToFollowing: (xPct: number, yPct: number) => void;
  onApplyToAll: (xPct: number, yPct: number) => void;
  fontFamily?: string | null;
}

/**
 * Precision editor for a single cue's subtitle position. Big frame,
 * axis-lock, keyboard nudges, and "apply to following / all" shortcuts so
 * users don't have to reposition every cue by hand.
 */
export function CuePositionDialog({
  open, onOpenChange, cue, videoSrc, defaultX, defaultY, fontSize, outline, videoWidth, lockAxis, onLockAxisChange,
  onChange, onReset, onApplyToFollowing, onApplyToAll,
}: Props) {
  const cx = cue?.xPct ?? defaultX;
  const cy = cue?.yPct ?? defaultY;
  const mid = useMemo(() => (cue ? (cue.start + cue.end) / 2 : 0), [cue]);

  // Keyboard nudges — arrows = 1%, shift+arrows = 5%. Respect lock axis.
  useEffect(() => {
    if (!open || !cue) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      const step = e.shiftKey ? 5 : 1;
      const patch: { xPct?: number; yPct?: number } = {};
      if (e.key === "ArrowLeft" && lockAxis !== "y") patch.xPct = Math.max(0, Math.round(cx) - step);
      if (e.key === "ArrowRight" && lockAxis !== "y") patch.xPct = Math.min(100, Math.round(cx) + step);
      if (e.key === "ArrowUp" && lockAxis !== "x") patch.yPct = Math.max(0, Math.round(cy) - step);
      if (e.key === "ArrowDown" && lockAxis !== "x") patch.yPct = Math.min(100, Math.round(cy) + step);
      if (patch.xPct !== undefined || patch.yPct !== undefined) {
        e.preventDefault();
        onChange(patch);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, cue, cx, cy, lockAxis, onChange]);

  if (!cue) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            Position subtitle · cue #{cue.index}{" "}
            <span className="font-mono text-xs text-muted-foreground">
              {formatSeconds(cue.start)} – {formatSeconds(cue.end)}
            </span>
          </DialogTitle>
          <DialogDescription>
            Drag on the frame or use the sliders. Arrow keys nudge 1%, Shift+arrow nudges 5%.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {videoSrc ? (
            <CuePreview
              videoSrc={videoSrc}
              time={mid}
              xPct={cx}
              yPct={cy}
              fontSize={fontSize}
              outline={outline}
              text={cue.text}
              videoWidth={videoWidth}
              lockAxis={lockAxis}
              onChange={onChange}
              size="large"
              eager
            />
          ) : (
            <div className="rounded-md border bg-muted/20 aspect-video grid place-items-center text-sm text-muted-foreground">
              No video source loaded
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Label className="text-xs">Lock axis</Label>
              <ToggleGroup
                type="single"
                size="sm"
                value={lockAxis}
                onValueChange={(v) => v && onLockAxisChange(v as LockAxis)}
              >
                <ToggleGroupItem value="free" aria-label="Free"><LockKeyhole className="h-3 w-3 mr-1 opacity-40" />Free</ToggleGroupItem>
                <ToggleGroupItem value="y" aria-label="Vertical only"><MoveVertical className="h-3 w-3 mr-1" />Y only</ToggleGroupItem>
                <ToggleGroupItem value="x" aria-label="Horizontal only"><MoveHorizontal className="h-3 w-3 mr-1" />X only</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={onReset}>
                <RotateCcw className="h-3 w-3 mr-1" /> Reset
              </Button>
              <Button size="sm" variant="outline" onClick={() => onApplyToFollowing(Math.round(cx), Math.round(cy))}>
                <ArrowDownToLine className="h-3 w-3 mr-1" /> Apply to following
              </Button>
              <Button size="sm" onClick={() => onApplyToAll(Math.round(cx), Math.round(cy))}>
                <ArrowRightToLine className="h-3 w-3 mr-1" /> Apply to all cues
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between">
                <Label className="text-xs">Horizontal (X)</Label>
                <span className="text-xs text-muted-foreground">{Math.round(cx)}%</span>
              </div>
              <Slider
                min={0}
                max={100}
                step={1}
                value={[Math.round(cx)]}
                disabled={lockAxis === "y"}
                onValueChange={(v) => onChange({ xPct: v[0] })}
              />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label className="text-xs">Vertical (Y)</Label>
                <span className="text-xs text-muted-foreground">{Math.round(cy)}%</span>
              </div>
              <Slider
                min={0}
                max={100}
                step={1}
                value={[Math.round(cy)]}
                disabled={lockAxis === "x"}
                onValueChange={(v) => onChange({ yPct: v[0] })}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
