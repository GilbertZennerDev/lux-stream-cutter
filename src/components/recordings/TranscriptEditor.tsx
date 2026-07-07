import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Download, Upload, Save, Plus, Trash2, Loader2 } from "lucide-react";
import { getRecordingDownloadUrl, saveRecordingTranscript } from "@/lib/recordings.functions";
import { cuesToSrt, type SrtCue } from "@/lib/subtitles/luxasrToSrt";
import { parseSrt } from "@/lib/subtitles/parseSrt";
import { toSrtTimestamp, parseTimeToSeconds } from "@/lib/subtitles/parseTime";

interface Props {
  recordingId: string;
  title: string;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

// mm:ss.mmm formatter for input fields
function fmt(t: number): string {
  const mm = Math.floor(t / 60);
  const ss = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function parseMs(v: string, fallback: number): number {
  try {
    const s = v.trim();
    if (!s) return fallback;
    // Accept "mm:ss.mmm" or "mm:ss" or plain seconds.
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    // parseTimeToSeconds handles h:mm:ss, mm:ss, ss including .ms
    return parseTimeToSeconds(s.replace(",", "."));
  } catch {
    return fallback;
  }
}

export function TranscriptEditor({ recordingId, title, open, onClose, onSaved }: Props) {
  const [cues, setCues] = useState<SrtCue[]>([]);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { transcript } = await getRecordingDownloadUrl({ data: { id: recordingId } });
        if (cancelled) return;
        if (transcript && transcript.length > 0) {
          setCues(
            transcript.map((c, i) => ({
              index: c.index ?? i + 1,
              start: c.start,
              end: c.end,
              text: c.text,
            })),
          );
        } else {
          setCues([]);
        }
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, recordingId]);

  const save = useMutation({
    mutationFn: async () => {
      const clean = cues
        .filter((c) => c.text.trim().length > 0)
        .sort((a, b) => a.start - b.start)
        .map((c, i) => ({ index: i + 1, start: c.start, end: c.end, text: c.text.trim() }));
      await saveRecordingTranscript({
        data: { id: recordingId, cues: clean, srt: cuesToSrt(clean) },
      });
    },
    onSuccess: () => {
      toast.success("Transcript saved");
      onSaved?.();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const downloadSrt = () => {
    const srt = cuesToSrt(
      cues.map((c, i) => ({ index: i + 1, start: c.start, end: c.end, text: c.text })),
    );
    const blob = new Blob([srt], { type: "application/x-subrip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = title.replace(/[^\w.-]+/g, "_");
    a.href = url;
    a.download = `${safe || "transcript"}.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onUpload = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const parsed = parseSrt(text);
      if (parsed.length === 0) throw new Error("No cues found in SRT");
      setCues(parsed);
      toast.success(`Loaded ${parsed.length} cues from ${f.name}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const updateCue = (idx: number, patch: Partial<SrtCue>) =>
    setCues((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  const deleteCue = (idx: number) =>
    setCues((prev) => prev.filter((_, i) => i !== idx));
  const addCueAfter = (idx: number) =>
    setCues((prev) => {
      const at = prev[idx];
      const nextStart = at ? at.end : 0;
      const cue: SrtCue = { index: 0, start: nextStart, end: nextStart + 2, text: "" };
      const arr = [...prev];
      arr.splice(idx + 1, 0, cue);
      return arr;
    });

  const totalSeconds = useMemo(
    () => cues.reduce((m, c) => Math.max(m, c.end), 0),
    [cues],
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">Edit transcript · {title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
          <div className="text-xs text-muted-foreground">
            {loading ? "Loading…" : `${cues.length} cue${cues.length === 1 ? "" : "s"} · ${toSrtTimestamp(totalSeconds)}`}
          </div>
          <div className="flex gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".srt,text/plain"
              className="hidden"
              onChange={(e) => onUpload(e.target.files)}
            />
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload className="h-3 w-3 mr-1" /> Upload SRT
            </Button>
            <Button size="sm" variant="outline" onClick={downloadSrt} disabled={cues.length === 0}>
              <Download className="h-3 w-3 mr-1" /> Download SRT
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setCues((prev) => [
                  ...prev,
                  { index: 0, start: totalSeconds, end: totalSeconds + 2, text: "" },
                ])
              }
            >
              <Plus className="h-3 w-3 mr-1" /> Add cue
            </Button>
          </div>
        </div>

        <ScrollArea className="max-h-[60vh] pr-2">
          {loading ? (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading transcript…
            </div>
          ) : cues.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No transcript yet. Upload an SRT file or add a cue.
            </p>
          ) : (
            <ul className="divide-y">
              {cues.map((c, i) => (
                <li key={i} className="py-2 grid grid-cols-[70px_90px_90px_1fr_auto] gap-2 items-start">
                  <div className="text-xs font-mono text-muted-foreground pt-2">#{i + 1}</div>
                  <Input
                    className="h-8 font-mono text-xs"
                    defaultValue={fmt(c.start)}
                    onBlur={(e) => updateCue(i, { start: parseMs(e.target.value, c.start) })}
                  />
                  <Input
                    className="h-8 font-mono text-xs"
                    defaultValue={fmt(c.end)}
                    onBlur={(e) => updateCue(i, { end: parseMs(e.target.value, c.end) })}
                  />
                  <Textarea
                    className="min-h-[38px] text-xs"
                    value={c.text}
                    onChange={(e) => updateCue(i, { text: e.target.value })}
                    rows={2}
                  />
                  <div className="flex flex-col gap-1">
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => addCueAfter(i)} title="Add after">
                      <Plus className="h-3 w-3" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => deleteCue(i)} title="Delete">
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || loading}>
            {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save transcript
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
