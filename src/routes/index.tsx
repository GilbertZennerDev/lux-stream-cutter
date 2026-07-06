import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  CheckCircle2, Circle, Loader2, Upload, Download, Scissors,
  Music, Cloud, FileText, Type, Flame, Play,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";

import { parseTimeToSeconds, formatSeconds } from "@/lib/subtitles/parseTime";
import { cutVideo, extractAudioMp3, burnSubtitles } from "@/lib/ffmpeg/operations";
import { onFfmpegLog } from "@/lib/ffmpeg/client";
import { luxasrJsonToCues, cuesToSrt } from "@/lib/subtitles/luxasrToSrt";
import { shortenCues } from "@/lib/subtitles/shortenSrt";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Video Cutter & Auto-Subtitler Pro" },
      {
        name: "description",
        content:
          "Cut videos in-browser and auto-generate Luxembourgish subtitles with LuxASR. Trim, transcribe, and burn-in captions — all client-side.",
      },
      { property: "og:title", content: "Video Cutter & Auto-Subtitler Pro" },
      {
        property: "og:description",
        content: "Browser-based video cutter with Luxembourgish auto-subtitles (LuxASR).",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: Dashboard,
});

type Stage =
  | "idle" | "cutting" | "extracting" | "asr"
  | "srt" | "shortening" | "burning" | "done" | "error";

type Mode = "full" | "cut-only" | "subs-only";

const STAGES: { key: Stage; label: string; icon: typeof Circle }[] = [
  { key: "cutting", label: "Cutting", icon: Scissors },
  { key: "extracting", label: "Audio", icon: Music },
  { key: "asr", label: "LuxASR", icon: Cloud },
  { key: "srt", label: "SRT", icon: FileText },
  { key: "shortening", label: "Shorten", icon: Type },
  { key: "burning", label: "Burn-in", icon: Flame },
];

function Dashboard() {
  const [file, setFile] = useState<File | null>(null);
  const [start, setStart] = useState("00:00");
  const [end, setEnd] = useState("00:30");
  const [mode, setMode] = useState<Mode>("full");
  const [fontSize, setFontSize] = useState(28);
  const [maxSentences, setMaxSentences] = useState(2);
  const [maxChars, setMaxChars] = useState(90);
  const [burnIn, setBurnIn] = useState(true);
  const [lowPerf, setLowPerf] = useState(false);
  const [maxHeight, setMaxHeight] = useState<0 | 480 | 720 | 1080>(0);

  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const [clipBlob, setClipBlob] = useState<Blob | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [srtText, setSrtText] = useState<string | null>(null);
  const [subbedBlob, setSubbedBlob] = useState<Blob | null>(null);

  const logRef = useRef<HTMLDivElement>(null);

  const appendLog = useCallback((msg: string) => {
    setLogs((l) => {
      const next = [...l, msg];
      return next.length > 400 ? next.slice(-400) : next;
    });
  }, []);

  // Attach ffmpeg log listener once
  useMemo(() => {
    onFfmpegLog((m) => appendLog(m));
  }, [appendLog]);

  const durationInfo = useMemo(() => {
    try {
      const s = parseTimeToSeconds(start);
      const e = parseTimeToSeconds(end);
      if (e <= s) return { ok: false as const, msg: "End must be after start" };
      return { ok: true as const, seconds: e - s, label: formatSeconds(e - s) };
    } catch (err) {
      return { ok: false as const, msg: (err as Error).message };
    }
  }, [start, end]);

  const canRun = file && stage !== "cutting" && stage !== "extracting" &&
    stage !== "asr" && stage !== "srt" && stage !== "shortening" && stage !== "burning";

  const run = async () => {
    if (!file) return;
    setError(null);
    setClipBlob(null); setAudioBlob(null); setSrtText(null); setSubbedBlob(null);
    setLogs([]);
    setProgress(0);
    try {
      let workingVideo: Blob = file;

      // Stage 1: Cut (skipped in subs-only mode)
      if (mode !== "subs-only") {
        setStage("cutting");
        if (!durationInfo.ok) throw new Error(durationInfo.msg);
        const s = parseTimeToSeconds(start);
        const e = parseTimeToSeconds(end);
        const cut = await cutVideo(file, s, e, setProgress, { lowPerf, maxHeight });
        const clip = new Blob([cut as BlobPart], { type: "video/mp4" });
        setClipBlob(clip);
        workingVideo = clip;
        setProgress(1);
      }

      if (mode === "cut-only") {
        setStage("done");
        toast.success("Clip ready");
        return;
      }

      // Stage 2: Audio
      setStage("extracting");
      setProgress(0);
      const audioBytes = await extractAudioMp3(workingVideo, setProgress, { lowPerf });
      const audio = new Blob([audioBytes as BlobPart], { type: "audio/mpeg" });
      setAudioBlob(audio);
      setProgress(1);

      // Stage 3: LuxASR
      setStage("asr");
      setProgress(0);
      appendLog(`[ASR] Uploading ${(audio.size / 1024).toFixed(0)} KB to LuxASR…`);
      const asrRes = await fetch("/api/asr", {
        method: "POST",
        headers: {
          "content-type": "audio/mpeg",
          "x-filename": "clip.mp3",
        },
        body: audio,
      });
      if (!asrRes.ok) {
        const body = await asrRes.json().catch(() => ({ error: asrRes.statusText }));
        throw new Error(`LuxASR: ${body.error ?? asrRes.statusText}`);
      }
      const asrJson = (await asrRes.json()) as { result: unknown };
      appendLog("[ASR] Transcription received");

      // Stage 4: SRT
      setStage("srt");
      const cues = luxasrJsonToCues(asrJson.result);
      if (cues.length === 0) throw new Error("LuxASR returned no segments");
      let workingCues = cues;

      // Stage 5: Shorten
      setStage("shortening");
      workingCues = shortenCues(cues, { maxSentences, maxChars });
      const srt = cuesToSrt(workingCues);
      setSrtText(srt);
      appendLog(`[SRT] ${workingCues.length} cues generated`);

      // Stage 6: Burn-in
      if (burnIn) {
        setStage("burning");
        setProgress(0);
        const subbed = await burnSubtitles(workingVideo, srt, fontSize, setProgress, { lowPerf, maxHeight });
        setSubbedBlob(new Blob([subbed as BlobPart], { type: "video/mp4" }));
        setProgress(1);
      }

      setStage("done");
      toast.success("Pipeline complete");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(err);
      appendLog(`[ERROR] ${message}`);
      setError(message);
      setStage("error");
      toast.error(message);
    }
  };

  const download = (blob: Blob | null, name: string) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const clipPreviewUrl = useMemo(
    () => (clipBlob ? URL.createObjectURL(clipBlob) : null),
    [clipBlob],
  );
  const subbedPreviewUrl = useMemo(
    () => (subbedBlob ? URL.createObjectURL(subbedBlob) : null),
    [subbedBlob],
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-md bg-primary text-primary-foreground grid place-items-center">
              <Scissors className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">
                Video Cutter &amp; Auto-Subtitler Pro
              </h1>
              <p className="text-xs text-muted-foreground">
                Browser-based · Luxembourgish (LuxASR)
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* LEFT: Controls */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">1. Source video</CardTitle>
            </CardHeader>
            <CardContent>
              <label
                htmlFor="video-input"
                className="flex flex-col items-center justify-center border-2 border-dashed rounded-lg py-8 cursor-pointer hover:bg-muted/40 transition-colors"
              >
                <Upload className="h-6 w-6 mb-2 text-muted-foreground" />
                <p className="text-sm">
                  {file ? file.name : "Click or drop a video file"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  MP4 / MKV / MOV / TS · recommended ≤ 500 MB
                </p>
                <input
                  id="video-input"
                  type="file"
                  accept="video/*,.ts,.mkv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setFile(f);
                  }}
                />
              </label>
              {file && (
                <p className="text-xs text-muted-foreground mt-2">
                  {(file.size / (1024 * 1024)).toFixed(1)} MB · {file.type || "unknown"}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">2. Cut &amp; options</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
                <TabsList className="grid grid-cols-3 w-full">
                  <TabsTrigger value="full">Full pipeline</TabsTrigger>
                  <TabsTrigger value="cut-only">Just cut</TabsTrigger>
                  <TabsTrigger value="subs-only">Subs only</TabsTrigger>
                </TabsList>
                <TabsContent value="full" className="text-xs text-muted-foreground pt-2">
                  Cut → audio → LuxASR → SRT → shorten → burn-in.
                </TabsContent>
                <TabsContent value="cut-only" className="text-xs text-muted-foreground pt-2">
                  Only trim the video. No subtitles.
                </TabsContent>
                <TabsContent value="subs-only" className="text-xs text-muted-foreground pt-2">
                  Skip cutting. Transcribe the whole uploaded clip.
                </TabsContent>
              </Tabs>

              {mode !== "subs-only" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="start">Start</Label>
                    <Input
                      id="start" value={start}
                      onChange={(e) => setStart(e.target.value)}
                      placeholder="MM:SS or HH:MM:SS"
                    />
                  </div>
                  <div>
                    <Label htmlFor="end">End</Label>
                    <Input
                      id="end" value={end}
                      onChange={(e) => setEnd(e.target.value)}
                      placeholder="MM:SS or HH:MM:SS"
                    />
                  </div>
                  <div className="col-span-2 text-xs">
                    {durationInfo.ok ? (
                      <span className="text-muted-foreground">
                        Duration: <span className="font-mono">{durationInfo.label}</span>
                      </span>
                    ) : (
                      <span className="text-destructive">{durationInfo.msg}</span>
                    )}
                  </div>
                </div>
              )}

              {mode !== "cut-only" && (
                <div className="space-y-4 pt-1">
                  <div>
                    <div className="flex items-center justify-between">
                      <Label>Font size</Label>
                      <span className="text-xs text-muted-foreground">{fontSize}px</span>
                    </div>
                    <Slider
                      min={14} max={64} step={1} value={[fontSize]}
                      onValueChange={(v) => setFontSize(v[0])}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="maxSent">Max sentences / cue</Label>
                      <Input
                        id="maxSent" type="number" min={1} max={5}
                        value={maxSentences}
                        onChange={(e) => setMaxSentences(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="maxChars">Max chars / cue</Label>
                      <Input
                        id="maxChars" type="number" min={30} max={200}
                        value={maxChars}
                        onChange={(e) => setMaxChars(Math.max(30, Number(e.target.value) || 30))}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <Label htmlFor="burn">Burn subtitles into video</Label>
                      <p className="text-xs text-muted-foreground">
                        Off = SRT file only (faster)
                      </p>
                    </div>
                    <Switch id="burn" checked={burnIn} onCheckedChange={setBurnIn} />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <Label htmlFor="lowperf">Low-performance mode</Label>
                      <p className="text-xs text-muted-foreground">
                        For weak PCs: ultrafast preset, 1 thread. ~2–3× schneller.
                      </p>
                    </div>
                    <Switch id="lowperf" checked={lowPerf} onCheckedChange={setLowPerf} />
                  </div>
                  <div>
                    <Label>Output resolution</Label>
                    <p className="text-xs text-muted-foreground mb-2">
                      Kleiner = deutlich schneller beim Burn-in. Auch im Low-perf Modus wählbar.
                    </p>
                    <div className="grid grid-cols-4 gap-2">
                      {([
                        { v: 0 as const, label: "Source" },
                        { v: 480 as const, label: "480p" },
                        { v: 720 as const, label: "720p" },
                        { v: 1080 as const, label: "1080p" },
                      ]).map((o) => (
                        <Button
                          key={o.v}
                          type="button"
                          size="sm"
                          variant={maxHeight === o.v ? "default" : "outline"}
                          onClick={() => setMaxHeight(o.v)}
                        >
                          {o.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <Button
                onClick={run}
                disabled={!canRun}
                className="w-full"
                size="lg"
              >
                {stage !== "idle" && stage !== "done" && stage !== "error" ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Running…</>
                ) : (
                  <><Play className="h-4 w-4 mr-2" /> Run</>
                )}
              </Button>

              {error && (
                <Alert variant="destructive">
                  <AlertTitle>Pipeline failed</AlertTitle>
                  <AlertDescription className="break-words text-xs">{error}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>

        {/* RIGHT: Progress + outputs */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Pipeline</CardTitle>
            </CardHeader>
            <CardContent>
              <PipelineStepper current={stage} progress={progress} mode={mode} burnIn={burnIn} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Outputs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {clipPreviewUrl && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Cut clip</p>
                  <video src={clipPreviewUrl} controls className="w-full rounded-md bg-black" />
                </div>
              )}
              {subbedPreviewUrl && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">With burned subtitles</p>
                  <video src={subbedPreviewUrl} controls className="w-full rounded-md bg-black" />
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={!clipBlob}
                  onClick={() => download(clipBlob, "clip.mp4")}>
                  <Download className="h-4 w-4 mr-2" /> clip.mp4
                </Button>
                <Button variant="outline" size="sm" disabled={!audioBlob}
                  onClick={() => download(audioBlob, "clip.mp3")}>
                  <Download className="h-4 w-4 mr-2" /> clip.mp3
                </Button>
                <Button variant="outline" size="sm" disabled={!srtText}
                  onClick={() => download(
                    srtText ? new Blob([srtText], { type: "text/plain" }) : null,
                    "subtitles.srt",
                  )}>
                  <Download className="h-4 w-4 mr-2" /> subtitles.srt
                </Button>
                <Button variant="outline" size="sm" disabled={!subbedBlob}
                  onClick={() => download(subbedBlob, "clip_subbed.mp4")}>
                  <Download className="h-4 w-4 mr-2" /> clip_subbed.mp4
                </Button>
              </div>

              {srtText && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    Preview SRT
                  </summary>
                  <pre className="mt-2 p-3 bg-muted rounded-md overflow-auto max-h-64 whitespace-pre-wrap">
                    {srtText}
                  </pre>
                </details>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Log</CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-40 rounded-md border bg-muted/30 p-2">
                <div ref={logRef} className="font-mono text-[11px] leading-relaxed">
                  {logs.length === 0 ? (
                    <p className="text-muted-foreground">No logs yet.</p>
                  ) : (
                    logs.map((l, i) => <div key={i}>{l}</div>)
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </main>

      <footer className="mx-auto max-w-7xl px-6 py-8 text-xs text-muted-foreground">
        Processing runs entirely in your browser via ffmpeg.wasm. Only the extracted
        audio is sent to LuxASR (uni.lu) for transcription. Keep this tab open while jobs run.
      </footer>
    </div>
  );
}

function PipelineStepper({
  current, progress, mode, burnIn,
}: { current: Stage; progress: number; mode: Mode; burnIn: boolean }) {
  const active = STAGES.filter((s) => {
    if (mode === "cut-only") return s.key === "cutting";
    if (mode === "subs-only" && s.key === "cutting") return false;
    if (!burnIn && s.key === "burning") return false;
    return true;
  });

  const currentIdx = active.findIndex((s) => s.key === current);
  const doneIdx = current === "done" ? active.length : currentIdx;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 overflow-x-auto">
        {active.map((s, i) => {
          const isDone = i < doneIdx || current === "done";
          const isActive = i === currentIdx && current !== "done";
          const Icon = s.icon;
          return (
            <div key={s.key} className="flex items-center gap-1 shrink-0">
              <div
                className={
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs border " +
                  (isActive
                    ? "border-primary bg-primary/10 text-primary"
                    : isDone
                      ? "border-transparent bg-muted text-foreground"
                      : "border-transparent text-muted-foreground")
                }
              >
                {isActive ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : isDone ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <Icon className="h-3.5 w-3.5" />
                )}
                <span>{s.label}</span>
              </div>
              {i < active.length - 1 && (
                <div className="w-4 h-px bg-border" />
              )}
            </div>
          );
        })}
      </div>
      {current !== "idle" && current !== "done" && current !== "error" && (
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}
      {current === "idle" && (
        <p className="text-xs text-muted-foreground">
          Upload a video and click <span className="font-medium">Run</span>.
        </p>
      )}
      {current === "done" && (
        <p className="text-xs text-primary">Done — download your files below.</p>
      )}
    </div>
  );
}
