import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { cutVideo } from "@/lib/ffmpeg/operations";
import type { SrtCue } from "@/lib/subtitles/luxasrToSrt";
import { formatSeconds } from "@/lib/subtitles/parseTime";
import { detectLipSyncOffset } from "@/lib/lipsync/detectOffset";

interface Props {
  open: boolean;
  onClose: () => void;
  cues: SrtCue[];
  getSource: () => Blob | null;
  offset: number;
  setOffset: (n: number) => void;
}

const PAD_BEFORE = 2;
const PAD_AFTER = 3;

export function SyncCalibrator({ open, onClose, cues, getSource, offset, setOffset }: Props) {
  const [cueIdx, setCueIdx] = useState<number>(0);
  const [localOffset, setLocalOffset] = useState<number>(offset);
  const [busy, setBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoStatus, setAutoStatus] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (open) {
      setLocalOffset(offset);
      setCueIdx(0);
      setPreviewUrl((u) => {
        if (u) URL.revokeObjectURL(u);
        return null;
      });
    }
  }, [open, offset]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const cue = cues[cueIdx];

  const nudge = (delta: number) =>
    setLocalOffset((v) => Number((v + delta).toFixed(3)));

  const generate = async () => {
    const src = getSource();
    if (!src) {
      toast.error("Source not ready. Wait for the preview to finish preparing.");
      return;
    }
    if (!cue) {
      toast.error("Pick a cue first.");
      return;
    }
    setBusy(true);
    try {
      const start = Math.max(0, cue.start - PAD_BEFORE);
      const end = cue.end + PAD_AFTER;
      const out = await cutVideo(src, start, end, undefined, {
        lowPerf: true,
        audioOffsetSec: localOffset,
      });
      const blob = new Blob([out as BlobPart], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      // Autoplay after a tick.
      setTimeout(() => {
        videoRef.current?.play().catch(() => {});
      }, 50);
    } catch (err) {
      toast.error(`Preview failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    setOffset(Number(localOffset.toFixed(3)));
    toast.success(`Audio offset set to ${localOffset.toFixed(3)}s`);
    onClose();
  };

  const cueLabel = useMemo(() => {
    if (!cue) return "";
    const text = cue.text.replace(/\s+/g, " ").trim();
    return `#${cue.index} · ${formatSeconds(cue.start)}–${formatSeconds(cue.end)} · ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`;
  }, [cue]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Calibrate audio sync</DialogTitle>
          <DialogDescription>
            Pick a cue, generate a short preview around it, and nudge the offset until the lips match the audio. The value applies to all cuts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="sync-cue">Reference cue</Label>
            {cues.length === 0 ? (
              <p className="text-xs text-muted-foreground mt-1">
                Generate a transcript first — no cues available.
              </p>
            ) : (
              <select
                id="sync-cue"
                value={cueIdx}
                onChange={(e) => setCueIdx(Number(e.target.value))}
                className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
              >
                {cues.map((c, i) => (
                  <option key={c.index} value={i}>
                    #{c.index} · {formatSeconds(c.start)}–{formatSeconds(c.end)} ·{" "}
                    {c.text.replace(/\s+/g, " ").trim().slice(0, 80)}
                  </option>
                ))}
              </select>
            )}
            {cue && (
              <p className="mt-1 text-xs text-muted-foreground truncate">{cueLabel}</p>
            )}
          </div>

          <div>
            <Label>Offset (seconds)</Label>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <Button type="button" size="sm" variant="outline" onClick={() => nudge(-0.5)}>−0.5</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => nudge(-0.1)}>−0.1</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => nudge(-0.05)}>−0.05</Button>
              <Input
                type="number"
                step="0.01"
                value={localOffset}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setLocalOffset(Number.isFinite(n) ? n : 0);
                }}
                className="w-24 text-center"
              />
              <Button type="button" size="sm" variant="outline" onClick={() => nudge(0.05)}>+0.05</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => nudge(0.1)}>+0.1</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => nudge(0.5)}>+0.5</Button>
              {localOffset !== 0 && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setLocalOffset(0)}>
                  Reset
                </Button>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Positive = audio later, negative = audio earlier.
            </p>
          </div>

          <div>
            <Button type="button" size="sm" onClick={generate} disabled={busy || !cue}>
              {busy ? (
                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
              ) : (
                <Wand2 className="h-3 w-3 mr-2" />
              )}
              Generate preview with offset {localOffset.toFixed(3)}s
            </Button>
          </div>

          {previewUrl && (
            <div className="rounded-md border overflow-hidden bg-black">
              <video
                ref={videoRef}
                src={previewUrl}
                controls
                loop
                playsInline
                className="w-full max-h-[45vh]"
              />
              <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground bg-muted/40">
                <Play className="h-3 w-3" />
                Preview around cue #{cue?.index} · offset {localOffset.toFixed(3)}s
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={apply} disabled={busy}>
            Apply offset ({localOffset.toFixed(3)}s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
