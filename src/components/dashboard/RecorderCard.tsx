import { useCallback, useEffect, useRef, useState } from "react";
import { Radio, Square, Download, ArrowDown, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { startRecording, type RecorderHandle, type RecorderStatus } from "@/lib/hls/recorder";

const DEFAULT_URL =
  "https://media02.webtvlive.eu/chd-edge/smil:chamber_tv_hd.smil/playlist.m3u8";

interface Props {
  onUseRecording: (file: File) => void;
  onLog?: (msg: string) => void;
}

export function RecorderCard({ onUseRecording, onLog }: Props) {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState<RecorderStatus>({ segments: 0, bytes: 0, elapsedMs: 0 });
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [tick, setTick] = useState(0);
  const handleRef = useRef<RecorderHandle | null>(null);

  // Timer refresh while recording
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [recording]);

  const start = useCallback(async () => {
    setRecordedBlob(null);
    setStatus({ segments: 0, bytes: 0, elapsedMs: 0 });
    setStarting(true);
    try {
      const h = await startRecording(url);
      h.onStatus(setStatus);
      h.onLog((m) => onLog?.(m));
      handleRef.current = h;
      setRecording(true);
      onLog?.(`[HLS] Recording started`);
      toast.success("Recording started");
    } catch (err) {
      const m = (err as Error).message;
      onLog?.(`[HLS] Failed to start: ${m}`);
      toast.error(`Recorder: ${m}`);
    } finally {
      setStarting(false);
    }
  }, [url, onLog]);

  const stop = useCallback(async () => {
    const h = handleRef.current;
    if (!h) return;
    const blob = await h.stop();
    handleRef.current = null;
    setRecording(false);
    setRecordedBlob(blob);
    onLog?.(`[HLS] Stopped — ${(blob.size / 1024 / 1024).toFixed(2)} MB captured`);
    if (blob.size === 0) toast.error("No segments captured");
    else toast.success("Recording ready");
  }, [onLog]);

  const useIt = () => {
    if (!recordedBlob) return;
    const name = `recording_${new Date().toISOString().replace(/[:.]/g, "-")}.ts`;
    const f = new File([recordedBlob], name, { type: "video/mp2t" });
    onUseRecording(f);
    toast.message("Loaded into cutter");
  };

  const dl = () => {
    if (!recordedBlob) return;
    const u = URL.createObjectURL(recordedBlob);
    const a = document.createElement("a");
    a.href = u;
    a.download = `recording_${new Date().toISOString().replace(/[:.]/g, "-")}.ts`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  };

  const elapsed = Math.floor(status.elapsedMs / 1000);
  const hh = String(Math.floor(elapsed / 3600)).padStart(2, "0");
  const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  void tick; // used to trigger re-render

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Radio className="h-4 w-4" /> Live stream recorder
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label htmlFor="hls-url">HLS playlist URL</Label>
          <Input
            id="hls-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={recording || starting}
            placeholder="https://…/playlist.m3u8"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!recording ? (
            <Button onClick={start} disabled={starting || !url.trim()}>
              {starting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Radio className="h-4 w-4 mr-2" />}
              {starting ? "Starting…" : "Start recording"}
            </Button>
          ) : (
            <Button onClick={stop} variant="destructive">
              <Square className="h-4 w-4 mr-2" /> Stop
            </Button>
          )}

          {recordedBlob && !recording && (
            <>
              <Button onClick={useIt} variant="default">
                <ArrowDown className="h-4 w-4 mr-2" /> Use for cutting
              </Button>
              <Button onClick={dl} variant="outline">
                <Download className="h-4 w-4 mr-2" /> Download .ts
              </Button>
            </>
          )}
        </div>

        {(recording || status.segments > 0) && (
          <div className="text-xs text-muted-foreground flex flex-wrap gap-4 font-mono">
            <span>⏱ {hh}:{mm}:{ss}</span>
            <span>▸ {status.segments} segments</span>
            <span>▸ {(status.bytes / 1024 / 1024).toFixed(2)} MB</span>
            {status.lastError && <span className="text-destructive">! {status.lastError}</span>}
          </div>
        )}

        {recordedBlob && !recording && (
          <p className="text-xs text-muted-foreground">
            Recorded {(recordedBlob.size / 1024 / 1024).toFixed(2)} MB. Click <b>Use for cutting</b> to load it as the source video below.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
