import { createFileRoute, Link, useSearch, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { getRecordingDownloadUrl } from "@/lib/recordings.functions";
import { Radio, Library, Film } from "lucide-react";
import {
  CheckCircle2, Circle, Loader2, Upload, Download, Scissors,
  Music, Cloud, FileText, Type, Flame, Play, X,
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
import { onFfmpegLog, cancelFFmpeg } from "@/lib/ffmpeg/client";
import { luxasrJsonToCues, cuesToSrt, type SrtCue } from "@/lib/subtitles/luxasrToSrt";
import { shortenCues } from "@/lib/subtitles/shortenSrt";
import { RecorderCard } from "@/components/dashboard/RecorderCard";

const indexSearchSchema = z.object({
  recording: z.string().uuid().optional(),
});

export const Route = createFileRoute("/")({
  validateSearch: indexSearchSchema,
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

/** Decode MP3 and check RMS. Returns true if the track is effectively silent. */
async function isAudioSilent(blob: Blob, threshold = 0.005): Promise<boolean> {
  try {
    const AC: typeof AudioContext =
      (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    if (!AC) return false;
    const ctx = new AC();
    try {
      const buf = await blob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf.slice(0));
      if (decoded.length === 0) return true;
      const data = decoded.getChannelData(0);
      // Sample up to ~20k points for speed
      const step = Math.max(1, Math.floor(data.length / 20000));
      let sum = 0, n = 0;
      for (let i = 0; i < data.length; i += step) {
        const v = data[i];
        sum += v * v;
        n++;
      }
      const rms = Math.sqrt(sum / Math.max(1, n));
      return rms < threshold;
    } finally {
      ctx.close().catch(() => {});
    }
  } catch {
    // If decoding fails, treat as non-silent so the user still gets a transcription attempt.
    return false;
  }
}


const STAGES: { key: Stage; label: string; icon: typeof Circle }[] = [
  { key: "cutting", label: "Cutting", icon: Scissors },
  { key: "extracting", label: "Audio", icon: Music },
  { key: "asr", label: "LuxASR", icon: Cloud },
  { key: "srt", label: "SRT", icon: FileText },
  { key: "shortening", label: "Shorten", icon: Type },
  { key: "burning", label: "Burn-in", icon: Flame },
];

function Dashboard() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [sourceTitle, setSourceTitle] = useState<string | null>(null);
  const [loadingRecording, setLoadingRecording] = useState<string | null>(null);

  // If ?recording=<id> is present, fetch it and load into the pipeline.
  useEffect(() => {
    const id = search.recording;
    if (!id || loadingRecording === id) return;
    setLoadingRecording(id);
    (async () => {
      try {
        toast.message("Loading recording…");
        const { url, path, title } = await getRecordingDownloadUrl({ data: { id } });
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const blob = await res.blob();
        const name = path.split("/").pop() ?? "recording.ts";
        const f = new File([blob], name, { type: "video/mp2t" });
        setFile(f);
        setSourceTitle(title ?? name);
        toast.success(`Loaded ${(f.size / 1024 / 1024).toFixed(1)} MB`);
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        // Clear the search param so we don't re-load on rerender
        navigate({ to: "/", search: {}, replace: true });
      }
    })();
  }, [search.recording, loadingRecording, navigate]);


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
  const [cues, setCues] = useState<SrtCue[]>([]);

  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);

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

  const isRunning = stage === "cutting" || stage === "extracting" ||
    stage === "asr" || stage === "srt" || stage === "shortening" || stage === "burning";

  const cancel = useCallback(async () => {
    if (!isRunning) return;
    cancelledRef.current = true;
    abortRef.current?.abort();
    appendLog("[CANCEL] Aborting…");
    await cancelFFmpeg();
    setStage("idle");
    setProgress(0);
    toast.message("Cancelled");
  }, [isRunning, appendLog]);

  const run = async () => {
    if (!file) return;
    setError(null);
    setClipBlob(null); setAudioBlob(null); setSrtText(null); setSubbedBlob(null);
    setLogs([]);
    setProgress(0);
    cancelledRef.current = false;
    const ac = new AbortController();
    abortRef.current = ac;
    const checkCancel = () => {
      if (cancelledRef.current) throw new Error("Cancelled");
    };
    try {
      let workingVideo: Blob = file;

      // Stage 1: Cut (skipped in subs-only mode)
      if (mode !== "subs-only") {
        setStage("cutting");
        if (!durationInfo.ok) throw new Error(durationInfo.msg);
        const s = parseTimeToSeconds(start);
        const e = parseTimeToSeconds(end);
        const cut = await cutVideo(file, s, e, setProgress, { lowPerf, maxHeight });
        checkCancel();
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
      checkCancel();
      const audio = new Blob([audioBytes as BlobPart], { type: "audio/mpeg" });
      setAudioBlob(audio);
      setProgress(1);

      // Detect silence / empty audio → skip ASR pipeline, offer clip only.
      const silent = await isAudioSilent(audio);
      if (silent) {
        appendLog("[AUDIO] No audible content detected — skipping transcription");
        toast.message("No audio detected — clip ready for download");
        setStage("done");
        return;
      }


      // Stage 3: LuxASR
      setStage("asr");
      setProgress(0);
      appendLog(`[ASR] Uploading ${(audio.size / 1024).toFixed(0)} KB to LuxASR…`);
      const submitRes = await fetch("/api/asr", {
        method: "POST",
        headers: {
          "content-type": "audio/mpeg",
          "x-filename": "clip.mp3",
        },
        body: audio,
        signal: ac.signal,
      });
      if (!submitRes.ok) {
        const body = await submitRes.json().catch(() => ({ error: submitRes.statusText }));
        throw new Error(`LuxASR: ${body.error ?? submitRes.statusText}`);
      }
      const { jobId } = (await submitRes.json()) as { jobId: string };
      appendLog(`[ASR] Job ${jobId} submitted, polling…`);

      // Poll from the client so no single server request stays open for minutes.
      const startedAt = Date.now();
      const MAX_MS = 15 * 60 * 1000;
      const STALL_MS = 3 * 60 * 1000;
      let asrResult: unknown = null;
      let lastStatus = "";
      let lastProgressAt = Date.now();
      while (true) {
        checkCancel();
        if (Date.now() - startedAt > MAX_MS) throw new Error("LuxASR polling timed out (15 min)");
        if (Date.now() - lastProgressAt > STALL_MS)
          throw new Error(
            `LuxASR stuck in "${lastStatus || "pending"}" for 3 min — aborting`,
          );
        await new Promise((r) => setTimeout(r, 3000));
        checkCancel();
        const pollRes = await fetch(`/api/asr?jobId=${encodeURIComponent(jobId)}`, {
          signal: ac.signal,
        });
        if (!pollRes.ok) {
          const body = await pollRes.json().catch(() => ({ error: pollRes.statusText }));
          throw new Error(`LuxASR: ${body.error ?? pollRes.statusText}`);
        }
        const p = (await pollRes.json()) as { status: string; result?: unknown };
        if (p.status === "completed") {
          asrResult = p.result;
          break;
        }
        if (p.status !== lastStatus) {
          lastStatus = p.status;
          lastProgressAt = Date.now();
          appendLog(`[ASR] status: ${p.status}`);
        }
      }

      const asrJson = { result: asrResult };
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
        checkCancel();
        setSubbedBlob(new Blob([subbed as BlobPart], { type: "video/mp4" }));
        setProgress(1);
      }

      setStage("done");
      toast.success("Pipeline complete");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (cancelledRef.current || message === "Cancelled" || (err as Error)?.name === "AbortError") {
        appendLog("[CANCEL] Pipeline stopped");
        setStage("idle");
        return;
      }
      console.error(err);
      appendLog(`[ERROR] ${message}`);
      setError(message);
      setStage("error");
      toast.error(message);
    } finally {
      abortRef.current = null;
    }
  };

  const transcribeForCuts = async () => {
    if (!file || isRunning) return;
    setError(null);
    setLogs([]);
    setCues([]);
    setSrtText(null);
    setAudioBlob(null);
    cancelledRef.current = false;
    const ac = new AbortController();
    abortRef.current = ac;
    const checkCancel = () => { if (cancelledRef.current) throw new Error("Cancelled"); };
    try {
      setStage("extracting");
      setProgress(0);
      const audioBytes = await extractAudioMp3(file, setProgress, { lowPerf });
      checkCancel();
      const audio = new Blob([audioBytes as BlobPart], { type: "audio/mpeg" });
      setAudioBlob(audio);
      setProgress(1);

      setStage("asr");
      setProgress(0);
      appendLog(`[ASR] Uploading ${(audio.size / 1024).toFixed(0)} KB to LuxASR…`);
      const submitRes = await fetch("/api/asr", {
        method: "POST",
        headers: { "content-type": "audio/mpeg", "x-filename": "clip.mp3" },
        body: audio,
        signal: ac.signal,
      });
      if (!submitRes.ok) {
        const body = await submitRes.json().catch(() => ({ error: submitRes.statusText }));
        throw new Error(`LuxASR: ${body.error ?? submitRes.statusText}`);
      }
      const { jobId } = (await submitRes.json()) as { jobId: string };
      appendLog(`[ASR] Job ${jobId} submitted, polling…`);

      const startedAt = Date.now();
      const MAX_MS = 15 * 60 * 1000;
      const STALL_MS = 3 * 60 * 1000;
      let asrResult: unknown = null;
      let lastStatus = "";
      let lastProgressAt = Date.now();
      while (true) {
        checkCancel();
        if (Date.now() - startedAt > MAX_MS) throw new Error("LuxASR polling timed out (15 min)");
        if (Date.now() - lastProgressAt > STALL_MS)
          throw new Error(`LuxASR stuck in "${lastStatus || "pending"}" for 3 min — aborting`);
        await new Promise((r) => setTimeout(r, 3000));
        checkCancel();
        const pollRes = await fetch(`/api/asr?jobId=${encodeURIComponent(jobId)}`, { signal: ac.signal });
        if (!pollRes.ok) {
          const body = await pollRes.json().catch(() => ({ error: pollRes.statusText }));
          throw new Error(`LuxASR: ${body.error ?? pollRes.statusText}`);
        }
        const p = (await pollRes.json()) as { status: string; result?: unknown };
        if (p.status === "completed") { asrResult = p.result; break; }
        if (p.status !== lastStatus) {
          lastStatus = p.status;
          lastProgressAt = Date.now();
          appendLog(`[ASR] status: ${p.status}`);
        }
      }

      setStage("srt");
      const raw = luxasrJsonToCues(asrResult);
      if (raw.length === 0) throw new Error("LuxASR returned no segments");
      setStage("shortening");
      const shortened = shortenCues(raw, { maxSentences, maxChars });
      setCues(shortened);
      setSrtText(cuesToSrt(shortened));
      appendLog(`[CUES] ${shortened.length} blocks ready — pick your cut points below`);
      setStage("done");
      toast.success(`${shortened.length} subtitle blocks — click a block to set start/end`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (cancelledRef.current || message === "Cancelled" || (err as Error)?.name === "AbortError") {
        appendLog("[CANCEL] Transcription stopped");
        setStage("idle");
        return;
      }
      console.error(err);
      appendLog(`[ERROR] ${message}`);
      setError(message);
      setStage("error");
      toast.error(message);
    } finally {
      abortRef.current = null;
    }
  };

  const setStartFromSeconds = (t: number) => {
    setStart(formatSeconds(t));
    setTimeout(() => seekTo(startVideoRef, formatSeconds(t)), 50);
  };
  const setEndFromSeconds = (t: number) => {
    setEnd(formatSeconds(t));
    setTimeout(() => seekTo(endVideoRef, formatSeconds(t)), 50);
  };

  const canRun = !!file && !isRunning;



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

  const sourcePreviewUrl = useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file],
  );
  useEffect(() => {
    return () => {
      if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    };
  }, [sourcePreviewUrl]);

  const startVideoRef = useRef<HTMLVideoElement>(null);
  const endVideoRef = useRef<HTMLVideoElement>(null);
  const seekTo = (ref: React.RefObject<HTMLVideoElement | null>, timeStr: string) => {
    const v = ref.current;
    if (!v) return;
    try {
      const t = parseTimeToSeconds(timeStr);
      if (isFinite(t) && t >= 0) {
        v.currentTime = Math.min(t, v.duration || t);
        v.play().catch(() => {});
      }
    } catch { /* ignore */ }
  };

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
          <nav className="flex items-center gap-1 text-sm">
            <Link to="/studio" className="px-3 py-1.5 rounded-md hover:bg-muted flex items-center gap-1.5">
              <Radio className="h-4 w-4" /> Studio
            </Link>
            <Link to="/recordings" className="px-3 py-1.5 rounded-md hover:bg-muted flex items-center gap-1.5">
              <Library className="h-4 w-4" /> Recordings
            </Link>
            <Link to="/premiere" className="px-3 py-1.5 rounded-md hover:bg-muted flex items-center gap-1.5">
              <Film className="h-4 w-4" /> Premiere
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* LEFT: Controls */}
        <div className="space-y-6">
          <RecorderCard
            onUseRecording={(f) => setFile(f)}
            onLog={(m) => appendLog(m)}
          />

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
                <p className="text-sm text-center px-4 break-all">
                  {file ? (sourceTitle ?? file.name) : "Click or drop a video file"}
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
                    if (f) {
                      setFile(f);
                      setSourceTitle(null);
                    }
                  }}
                />
              </label>
              {file && (
                <p className="text-xs text-muted-foreground mt-2">
                  {(file.size / (1024 * 1024)).toFixed(1)} MB · {file.type || "unknown"}
                  {sourceTitle && sourceTitle !== file.name && (
                    <span className="ml-2 font-mono opacity-60">{file.name}</span>
                  )}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <span>Find cut points via transcript</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!file || isRunning}
                  onClick={transcribeForCuts}
                >
                  {isRunning && (stage === "extracting" || stage === "asr" || stage === "srt" || stage === "shortening") ? (
                    <><Loader2 className="h-3 w-3 mr-2 animate-spin" /> Transcribing…</>
                  ) : (
                    <><FileText className="h-3 w-3 mr-2" /> Transcribe</>
                  )}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {cues.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Transcribes the <strong>entire</strong> video (no cutting) so you can browse
                  subtitle blocks with timestamps. Click any block to jump the previews, or use
                  its buttons to set Start / End on the cut range above.
                </p>
              ) : (
                <ScrollArea className="h-72 rounded-md border">
                  <ul className="divide-y">
                    {cues.map((c) => (
                      <li key={c.index} className="p-2 hover:bg-muted/40 group">
                        <div className="flex items-center gap-2 mb-1">
                          <button
                            type="button"
                            className="text-[11px] font-mono text-primary hover:underline"
                            onClick={() => seekTo(startVideoRef, formatSeconds(c.start))}
                            title="Preview at this timestamp"
                          >
                            {formatSeconds(c.start)} – {formatSeconds(c.end)}
                          </button>
                          <div className="ml-auto flex gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                            <Button
                              size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
                              onClick={() => setStartFromSeconds(c.start)}
                            >
                              ▸ Start
                            </Button>
                            <Button
                              size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
                              onClick={() => setEndFromSeconds(c.end)}
                            >
                              End ◂
                            </Button>
                          </div>
                        </div>
                        <p className="text-xs leading-snug">{c.text}</p>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
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
                  <div className="space-y-2">
                    <Label htmlFor="start">Start</Label>
                    <Input
                      id="start" value={start}
                      onChange={(e) => setStart(e.target.value)}
                      placeholder="MM:SS or HH:MM:SS"
                    />
                    {sourcePreviewUrl && (
                      <div className="space-y-1">
                        <video
                          ref={startVideoRef}
                          src={sourcePreviewUrl}
                          className="w-full rounded-md border bg-black aspect-video"
                          controls
                          muted
                          preload="metadata"
                          onLoadedMetadata={() => seekTo(startVideoRef, start)}
                        />
                        <Button
                          type="button" size="sm" variant="outline" className="w-full h-7 text-xs"
                          onClick={() => seekTo(startVideoRef, start)}
                        >
                          <Play className="h-3 w-3 mr-1" /> Preview start
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="end">End</Label>
                    <Input
                      id="end" value={end}
                      onChange={(e) => setEnd(e.target.value)}
                      placeholder="MM:SS or HH:MM:SS"
                    />
                    {sourcePreviewUrl && (
                      <div className="space-y-1">
                        <video
                          ref={endVideoRef}
                          src={sourcePreviewUrl}
                          className="w-full rounded-md border bg-black aspect-video"
                          controls
                          muted
                          preload="metadata"
                          onLoadedMetadata={() => seekTo(endVideoRef, end)}
                        />
                        <Button
                          type="button" size="sm" variant="outline" className="w-full h-7 text-xs"
                          onClick={() => seekTo(endVideoRef, end)}
                        >
                          <Play className="h-3 w-3 mr-1" /> Preview end
                        </Button>
                      </div>
                    )}
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
                    <div className="mt-2 rounded-md border bg-black aspect-video flex items-end justify-center p-3 overflow-hidden">
                      <span
                        className="font-sans font-semibold text-white text-center leading-tight"
                        style={{
                          fontSize: `${fontSize}px`,
                          textShadow: "0 0 4px #000, 2px 2px 3px #000, -1px -1px 2px #000",
                        }}
                      >
                        Beispill Ennertitlen
                      </span>
                    </div>
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

              <div className="flex gap-2">
                <Button
                  onClick={run}
                  disabled={!canRun}
                  className="flex-1"
                  size="lg"
                >
                  {isRunning ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Running…</>
                  ) : (
                    <><Play className="h-4 w-4 mr-2" /> Run</>
                  )}
                </Button>
                {isRunning && (
                  <Button
                    onClick={cancel}
                    variant="destructive"
                    size="lg"
                  >
                    <X className="h-4 w-4 mr-2" /> Cancel
                  </Button>
                )}
              </div>

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
