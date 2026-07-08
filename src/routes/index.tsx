import { createFileRoute, Link, useSearch, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  getRecordingDownloadUrl,
  saveRecordingTranscript,
  createRecording,
  markRecordingReady,
} from "@/lib/recordings.functions";
import { supabase } from "@/integrations/supabase/client";
import { Radio, Library, Film, Camera } from "lucide-react";
import {
  CheckCircle2,
  Circle,
  Loader2,
  Upload,
  Download,
  Scissors,
  Music,
  Cloud,
  FileText,
  Type,
  Flame,
  Play,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";

import { parseTimeToSeconds, formatSeconds } from "@/lib/subtitles/parseTime";
import {
  cutAndConcat,
  extractAudioMp3,
  burnSubtitles,
  remuxTsToMp4,
  cuesToAss,
  getVideoDimensions,
} from "@/lib/ffmpeg/operations";
import { onFfmpegLog, cancelFFmpeg } from "@/lib/ffmpeg/client";
import { luxasrJsonToCues, cuesToSrt, type SrtCue } from "@/lib/subtitles/luxasrToSrt";
import { shortenCues } from "@/lib/subtitles/shortenSrt";
import {
  ensureSharedRecorder,
  snapshotSharedRecorderDelta,
  getSharedRecorderInfo,
  getSharedStreamUrl,
  setSharedStreamUrl,
  DEFAULT_STREAM_URL,
} from "@/lib/hls/shared-recorder";
import { SubtitlePreview } from "@/components/cutter/SubtitlePreview";

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

type Stage = "idle" | "cutting" | "extracting" | "asr" | "srt" | "shortening" | "burning" | "done" | "error";

type Mode = "full" | "cut-only" | "subs-only";

/** Decode MP3 and check RMS. Returns true if the track is effectively silent. */
async function isAudioSilent(blob: Blob, threshold = 0.005): Promise<boolean> {
  try {
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    const ctx = new AC();
    try {
      const buf = await blob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf.slice(0));
      if (decoded.length === 0) return true;
      const data = decoded.getChannelData(0);
      // Sample up to ~20k points for speed
      const step = Math.max(1, Math.floor(data.length / 20000));
      let sum = 0,
        n = 0;
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

function inferVideoMime(fileName: string, responseType?: string | null): string {
  const cleanType = (responseType ?? "").split(";")[0].trim().toLowerCase();
  const ext = fileName.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "ts":
    case "m2ts":
      return "video/mp2t";
    default:
      if (cleanType && cleanType !== "application/octet-stream" && cleanType !== "binary/octet-stream") {
        return cleanType;
      }
      return cleanType || "video/mp4";
  }
}

function isTransportStream(file: File | Blob, fileName = file instanceof File ? file.name : ""): boolean {
  const type = file.type.toLowerCase();
  return type === "video/mp2t" || /\.(m2ts|ts)$/i.test(fileName);
}

function isFfmpegFilesystemError(message: string): boolean {
  return /ErrnoError:\s*FS error|FS error/i.test(message);
}

function friendlyPipelineError(message: string, stage: Stage): string {
  if (!isFfmpegFilesystemError(message)) return message;
  switch (stage) {
    case "cutting":
      return "FFmpeg could not create the cut output for this source. Try a shorter range or enable Low-performance mode with 480p output.";
    case "extracting":
      return "FFmpeg could not extract a usable audio track from this clip. The video cut may still be ready.";
    case "burning":
      return "FFmpeg could not create the subtitle-burned video. Try Low-performance mode with 480p output, or download the clip and SRT separately.";
    default:
      return "FFmpeg could not create the expected output file for this step.";
  }
}

function formatDownloadBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

async function downloadRecordingFile(
  url: string,
  fileName: string,
  onProgress: (label: string) => void,
): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const type = inferVideoMime(fileName, res.headers.get("content-type"));
  const total = Number(res.headers.get("content-length") ?? "0");

  if (!res.body) {
    const blob = await res.blob();
    return new File([blob], fileName, { type: inferVideoMime(fileName, blob.type) });
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    onProgress(
      total > 0
        ? `Downloading ${formatDownloadBytes(received)} / ${formatDownloadBytes(total)}`
        : `Downloading ${formatDownloadBytes(received)}`,
    );
  }
  return new File(
    chunks.map((chunk) => chunk as BlobPart),
    fileName,
    { type },
  );
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
  const [recordingLoadLabel, setRecordingLoadLabel] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [sourcePreviewBlob, setSourcePreviewBlob] = useState<Blob | null>(null);
  const [sourcePreviewError, setSourcePreviewError] = useState<string | null>(null);
  const [isPreparingSourcePreview, setIsPreparingSourcePreview] = useState(false);
  const handledRecordingRef = useRef<string | null>(null);

  // Snapshot the running shared HLS recorder (URL configured in Studio, or
  // the one the Cutter itself starts on first snapshot).
  const [snapshotUrl, setSnapshotUrl] = useState(DEFAULT_STREAM_URL);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotProgress, setSnapshotProgress] = useState<string>("");
  const [sharedInfo, setSharedInfo] = useState<ReturnType<typeof getSharedRecorderInfo>>(null);

  // Hydrate URL from the shared store (Studio writes it there).
  useEffect(() => {
    const saved = getSharedStreamUrl();
    if (saved) setSnapshotUrl(saved);
  }, []);
  useEffect(() => {
    if (snapshotUrl) setSharedStreamUrl(snapshotUrl);
  }, [snapshotUrl]);

  // Refresh shared-recorder status every 2s so the UI shows buffered segments.
  useEffect(() => {
    const tick = () => setSharedInfo(getSharedRecorderInfo());
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, []);

  // If ?recording=<id> is present, fetch it and load into the pipeline.
  useEffect(() => {
    const id = search.recording;
    if (!id) return;
    if (handledRecordingRef.current === id) return;
    handledRecordingRef.current = id;
    setLoadingRecording(id);
    setRecordingLoadLabel("Preparing recording…");
    setFile(null);
    setSourceTitle(null);
    setRecordingId(null);
    setRawCues([]);
    setCues([]);
    setSelectedCues(new Set());
    setSrtText(null);
    setClipBlob(null);
    setAudioBlob(null);
    setSubbedBlob(null);
    setSourcePreviewBlob(null);
    setSourcePreviewError(null);
    setError(null);
    (async () => {
      try {
        toast.message("Loading recording…");
        setRecordingLoadLabel("Creating download link…");
        const { url, path, title, transcript, transcriptSrt } = await getRecordingDownloadUrl({ data: { id } });
        const name = path.split("/").pop() ?? "recording.ts";
        const f = await downloadRecordingFile(url, name, setRecordingLoadLabel);
        setFile(f);
        setSourceTitle(title ?? name);
        setRecordingId(id);
        if (transcript && Array.isArray(transcript) && transcript.length > 0) {
          const rawPreloaded: SrtCue[] = transcript.map((c, i) => ({
            index: c.index ?? i + 1,
            start: c.start,
            end: c.end,
            text: c.text,
          }));
          setRawCues(rawPreloaded);
          const shortened = shortenCues(rawPreloaded, { maxSentences, maxChars });
          setCues(shortened);
          setSrtText(cuesToSrt(shortened));
          toast.success(`Loaded ${(f.size / 1024 / 1024).toFixed(1)} MB · ${shortened.length} blocks`);
        } else {
          setRawCues([]);
          toast.success(`Loaded ${(f.size / 1024 / 1024).toFixed(1)} MB`);
        }
      } catch (err) {
        // Allow the user to retry by re-clicking Cut on the same recording.
        handledRecordingRef.current = null;
        toast.error((err as Error).message);
      } finally {
        setLoadingRecording(null);
        setRecordingLoadLabel(null);
      }
    })();
    // `navigate` intentionally excluded — including it would re-fire this
    // effect on every render (useNavigate returns a fresh reference) and
    // wipe the loaded file after ~1s.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.recording]);

  const runSnapshot = useCallback(async () => {
    if (snapshotBusy || !snapshotUrl) return;
    setSnapshotBusy(true);
    setSnapshotProgress("Preparing shared recorder…");
    const t = toast.loading("Saving live snapshot to Recordings…");
    try {
      // Ensure the background recorder is running against the configured URL.
      // If it wasn't already (e.g. Studio was never opened this session),
      // start it now and wait until at least one segment is buffered so the
      // first snapshot isn't empty.
      const before = getSharedRecorderInfo();
      const wasRunning = before?.url === snapshotUrl;
      await ensureSharedRecorder(snapshotUrl, (m) => setSnapshotProgress(m));
      if (!wasRunning) {
        setSnapshotProgress("Waiting for first segment…");
        const waitStart = Date.now();
        while (Date.now() - waitStart < 30_000) {
          const info = getSharedRecorderInfo();
          if (info && info.bufferedSegments > 0) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      setSnapshotProgress("Building snapshot…");
      const delta = await snapshotSharedRecorderDelta();
      if (!delta || delta.blob.size === 0) {
        throw new Error("Nothing buffered yet — wait a few seconds and try again");
      }

      setSnapshotProgress(`Uploading ${(delta.blob.size / 1024 / 1024).toFixed(1)} MB to Recordings…`);
      const sessionDate = delta.startedAt.toISOString().slice(0, 10);
      const chunkIndex = 9000 + (Math.floor(Date.now() / 1000) % 100000);
      const created = await createRecording({
        data: {
          sessionDate,
          chunkIndex,
          startedAt: delta.startedAt.toISOString(),
          sourceUrl: snapshotUrl,
          title: `Live snapshot ${new Date().toLocaleTimeString()}`,
          fileExt: "ts",
        },
      });
      const { error } = await supabase.storage
        .from("recordings")
        .uploadToSignedUrl(created.path, created.token, delta.blob, {
          contentType: "video/mp2t",
        });
      if (error) throw error;
      await markRecordingReady({
        data: {
          id: created.id,
          endedAt: delta.endedAt.toISOString(),
          sizeBytes: delta.blob.size,
        },
      });
      setSharedInfo(getSharedRecorderInfo());
      toast.success(
        `Snapshot saved (${delta.segments} segment${delta.segments === 1 ? "" : "s"} · ${(delta.blob.size / 1024 / 1024).toFixed(1)} MB)`,
        { id: t, duration: 6000 },
      );
    } catch (err) {
      toast.error(`Snapshot failed: ${(err as Error).message}`, { id: t });
    } finally {
      setSnapshotBusy(false);
      setSnapshotProgress("");
    }
  }, [snapshotBusy, snapshotUrl]);

  const [segments, setSegments] = useState<Array<{ start: string; end: string }>>([{ start: "00:00", end: "00:30" }]);
  const [activeSeg, setActiveSeg] = useState(0);

  const updateSeg = (i: number, patch: Partial<{ start: string; end: string }>) =>
    setSegments((s) => s.map((seg, idx) => (idx === i ? { ...seg, ...patch } : seg)));
  const addSeg = () => {
    setSegments((s) => [...s, { start: "00:00", end: "00:30" }]);
    setActiveSeg(segments.length);
  };
  const removeSeg = (i: number) => {
    setSegments((s) => (s.length <= 1 ? s : s.filter((_, idx) => idx !== i)));
    setActiveSeg((a) => Math.max(0, Math.min(a, segments.length - 2)));
  };
  const [mode, setMode] = useState<Mode>("full");
  const [fontSize, setFontSize] = useState(28);
  const [subX, setSubX] = useState(50); // % from left (centre of text)
  const [subY, setSubY] = useState(88); // % from top (centre of text)
  const [subOutline, setSubOutline] = useState(2); // px
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
  const [rawCues, setRawCues] = useState<SrtCue[]>([]);
  const [selectedCues, setSelectedCues] = useState<Set<number>>(new Set());

  const toggleCue = (idx: number) =>
    setSelectedCues((prev) => {
      const n = new Set(prev);
      if (n.has(idx)) n.delete(idx);
      else n.add(idx);
      return n;
    });
  const selectAllCues = () => setSelectedCues(new Set(cues.map((c) => c.index)));
  const clearSelectedCues = () => setSelectedCues(new Set());
  const updateCuePos = (idx: number, patch: { xPct?: number | undefined; yPct?: number | undefined }) =>
    setCues((prev) => prev.map((c) => (c.index === idx ? { ...c, ...patch } : c)));
  const resetCuePos = (idx: number) =>
    setCues((prev) => prev.map((c) => (c.index === idx ? { ...c, xPct: undefined, yPct: undefined } : c)));
  const updateCueText = (idx: number, text: string) =>
    setCues((prev) => {
      const next = prev.map((c) => (c.index === idx ? { ...c, text } : c));
      setSrtText(cuesToSrt(next));
      return next;
    });

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
      let total = 0;
      const parsed: Array<{ start: number; end: number }> = [];
      for (let i = 0; i < segments.length; i++) {
        const s = parseTimeToSeconds(segments[i].start);
        const e = parseTimeToSeconds(segments[i].end);
        if (e <= s) return { ok: false as const, msg: `Segment ${i + 1}: end must be after start` };
        total += e - s;
        parsed.push({ start: s, end: e });
      }
      return { ok: true as const, seconds: total, label: formatSeconds(total), parsed };
    } catch (err) {
      return { ok: false as const, msg: (err as Error).message };
    }
  }, [segments]);

  const isRunning =
    stage === "cutting" ||
    stage === "extracting" ||
    stage === "asr" ||
    stage === "srt" ||
    stage === "shortening" ||
    stage === "burning";

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
    // MPEG-TS through ffmpeg.wasm's cut/concat filter_complex path is
    // fragile — the WASM FS crashes ("ErrnoError: FS error") when the
    // stream-copy or filter graph fails to produce an output. If we've
    // already remuxed the TS to MP4 for the source preview, use that;
    // otherwise ask the user to wait for the remux to finish.
    if (isTransportStream(file) && !sourcePreviewBlob) {
      if (isPreparingSourcePreview) {
        toast.error("Still preparing the .ts source for cutting — try again in a few seconds.");
      } else if (sourcePreviewError) {
        toast.error(`Cannot cut this .ts file: ${sourcePreviewError}`);
      } else {
        toast.error("This .ts file hasn't been prepared for cutting yet.");
      }
      return;
    }
    const sourceForCut: Blob = isTransportStream(file) && sourcePreviewBlob ? sourcePreviewBlob : file;
    setError(null);
    setClipBlob(null);
    setAudioBlob(null);
    setSrtText(null);
    setSubbedBlob(null);
    setLogs([]);
    setProgress(0);
    cancelledRef.current = false;
    const ac = new AbortController();
    abortRef.current = ac;
    const checkCancel = () => {
      if (cancelledRef.current) throw new Error("Cancelled");
    };
    let activeStage: Stage = "idle";
    const moveToStage = (next: Stage) => {
      activeStage = next;
      setStage(next);
    };
    try {
      let workingVideo: Blob = sourceForCut;

      // Stage 1: Cut (skipped in subs-only mode)
      if (mode !== "subs-only") {
        moveToStage("cutting");
        if (!durationInfo.ok) throw new Error(durationInfo.msg);
        const cut = await cutAndConcat(sourceForCut, durationInfo.parsed, setProgress, { lowPerf, maxHeight });
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
      moveToStage("extracting");
      setProgress(0);
      let audioBytes: Uint8Array;
      try {
        audioBytes = await extractAudioMp3(workingVideo, setProgress, { lowPerf });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("No usable audio track") || isFfmpegFilesystemError(message)) {
          appendLog(`[AUDIO] ${friendlyPipelineError(message, "extracting")}`);
          toast.message("Clip ready — audio/subtitle steps skipped");
          moveToStage("done");
          return;
        }
        throw err;
      }
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
      moveToStage("asr");
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
          throw new Error(`LuxASR stuck in "${lastStatus || "pending"}" for 3 min — aborting`);
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
      moveToStage("srt");
      const cues = luxasrJsonToCues(asrJson.result);
      if (cues.length === 0) throw new Error("LuxASR returned no segments");
      let workingCues = cues;

      // Persist FULL transcript with timestamps to the recording row (if loaded from library).
      if (recordingId) {
        try {
          await saveRecordingTranscript({
            data: { id: recordingId, cues, srt: cuesToSrt(cues) },
          });
          appendLog(`[DB] Saved full transcript (${cues.length} segments) to recording`);
        } catch (e) {
          appendLog(`[DB] Failed to save transcript: ${(e as Error).message}`);
        }
      }

      // Stage 5: Shorten
      moveToStage("shortening");
      workingCues = shortenCues(cues, { maxSentences, maxChars });
      const srt = cuesToSrt(workingCues);
      setSrtText(srt);
      appendLog(`[SRT] ${workingCues.length} cues generated`);

      // Stage 6: Burn-in
      if (burnIn) {
        moveToStage("burning");
        setProgress(0);
        const dims = await getVideoDimensions(workingVideo);
        const ass = cuesToAss(workingCues, {
          fontSize,
          outline: subOutline,
          xPct: subX,
          yPct: subY,
          videoWidth: dims.width,
          videoHeight: dims.height,
        });
        const subbed = await burnSubtitles(workingVideo, ass, setProgress, { lowPerf, maxHeight });
        checkCancel();
        setSubbedBlob(new Blob([subbed as BlobPart], { type: "video/mp4" }));
        setProgress(1);
      }

      moveToStage("done");
      toast.success("Pipeline complete");
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = friendlyPipelineError(rawMessage, activeStage);
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
    const checkCancel = () => {
      if (cancelledRef.current) throw new Error("Cancelled");
    };
    let activeStage: Stage = "idle";
    const moveToStage = (next: Stage) => {
      activeStage = next;
      setStage(next);
    };

    // Fast path: reuse the stored full transcript, just re-shorten.
    if (rawCues.length > 0) {
      try {
        moveToStage("shortening");
        const shortened = shortenCues(rawCues, { maxSentences, maxChars });
        setCues(shortened);
        setSrtText(cuesToSrt(shortened));
        appendLog(`[CUES] Reused stored transcript → ${shortened.length} blocks`);
        moveToStage("done");
        toast.success(`${shortened.length} subtitle blocks (from saved transcript)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendLog(`[ERROR] ${message}`);
        setError(message);
        setStage("error");
        toast.error(message);
      } finally {
        abortRef.current = null;
      }
      return;
    }

    try {
      moveToStage("extracting");
      setProgress(0);
      const audioSource: Blob = isTransportStream(file) && sourcePreviewBlob ? sourcePreviewBlob : file;
      const audioBytes = await extractAudioMp3(audioSource, setProgress, { lowPerf });
      checkCancel();
      const audio = new Blob([audioBytes as BlobPart], { type: "audio/mpeg" });
      setAudioBlob(audio);
      setProgress(1);

      moveToStage("asr");
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

      moveToStage("srt");
      const raw = luxasrJsonToCues(asrResult);
      if (raw.length === 0) throw new Error("LuxASR returned no segments");
      setRawCues(raw);
      moveToStage("shortening");
      const shortened = shortenCues(raw, { maxSentences, maxChars });
      setCues(shortened);
      setSrtText(cuesToSrt(shortened));
      appendLog(`[CUES] ${shortened.length} blocks ready — pick your cut points below`);
      // Persist FULL transcript with timestamps to the recording row (if loaded from library).
      if (recordingId) {
        try {
          await saveRecordingTranscript({
            data: { id: recordingId, cues: raw, srt: cuesToSrt(raw) },
          });
          appendLog(`[DB] Saved full transcript (${raw.length} segments) to recording`);
        } catch (e) {
          appendLog(`[DB] Failed to save transcript: ${(e as Error).message}`);
        }
      }
      moveToStage("done");
      toast.success(`${shortened.length} subtitle blocks — click a block to set start/end`);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = friendlyPipelineError(rawMessage, activeStage);
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
    const v = formatSeconds(t);
    updateSeg(activeSeg, { start: v });
    setTimeout(() => seekTo(startVideoRef, v), 50);
  };
  const setEndFromSeconds = (t: number) => {
    const v = formatSeconds(t);
    updateSeg(activeSeg, { end: v });
    setTimeout(() => seekTo(endVideoRef, v), 50);
  };

  const cutFromSelectedCues = async () => {
    if (!file || isRunning) return;
    if (isTransportStream(file) && !sourcePreviewBlob) {
      toast.error(
        isPreparingSourcePreview
          ? "Still preparing the .ts source for cutting — try again in a few seconds."
          : "This .ts file hasn't been prepared for cutting yet.",
      );
      return;
    }
    const sourceForCut: Blob = isTransportStream(file) && sourcePreviewBlob ? sourcePreviewBlob : file;
    const picked = cues.filter((c) => selectedCues.has(c.index)).sort((a, b) => a.start - b.start);
    if (picked.length === 0) {
      toast.error("Select at least one transcript block first");
      return;
    }
    setError(null);
    setLogs([]);
    setClipBlob(null);
    setSubbedBlob(null);
    setSrtText(null);
    cancelledRef.current = false;
    const ac = new AbortController();
    abortRef.current = ac;
    const checkCancel = () => {
      if (cancelledRef.current) throw new Error("Cancelled");
    };
    let activeStage: Stage = "idle";
    const moveToStage = (next: Stage) => {
      activeStage = next;
      setStage(next);
    };
    try {
      const parsedSegments = picked.map((c) => ({ start: c.start, end: c.end }));

      // Build SRT with timestamps mapped into the concatenated output.
      let offset = 0;
      const remapped: SrtCue[] = picked.map((c, i) => {
        const segLen = c.end - c.start;
        const cue: SrtCue = {
          index: i + 1,
          start: offset,
          end: offset + segLen,
          text: c.text,
          xPct: c.xPct,
          yPct: c.yPct,
        };
        offset += segLen;
        return cue;
      });
      const srt = cuesToSrt(remapped);
      setSrtText(srt);

      moveToStage("cutting");
      setProgress(0);
      appendLog(`[CUT] ${picked.length} selected blocks → ${formatSeconds(offset)}`);
      const cut = await cutAndConcat(sourceForCut, parsedSegments, setProgress, { lowPerf, maxHeight });
      checkCancel();
      const clip = new Blob([cut as BlobPart], { type: "video/mp4" });
      setClipBlob(clip);
      setProgress(1);

      moveToStage("burning");
      setProgress(0);
      const dims = await getVideoDimensions(clip);
      const ass = cuesToAss(remapped, {
        fontSize,
        outline: subOutline,
        xPct: subX,
        yPct: subY,
        videoWidth: dims.width,
        videoHeight: dims.height,
      });
      const subbed = await burnSubtitles(clip, ass, setProgress, { lowPerf, maxHeight });
      checkCancel();
      setSubbedBlob(new Blob([subbed as BlobPart], { type: "video/mp4" }));
      setProgress(1);

      moveToStage("done");
      toast.success(`Cut ${picked.length} blocks with subtitles`);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = friendlyPipelineError(rawMessage, activeStage);
      if (cancelledRef.current || message === "Cancelled" || (err as Error)?.name === "AbortError") {
        appendLog("[CANCEL] Stopped");
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

  const canRun = !!file && !isRunning;

  const download = (blob: Blob | null, name: string) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const clipPreviewUrl = useMemo(() => (clipBlob ? URL.createObjectURL(clipBlob) : null), [clipBlob]);
  const subbedPreviewUrl = useMemo(() => (subbedBlob ? URL.createObjectURL(subbedBlob) : null), [subbedBlob]);

  const sourcePreviewUrl = useMemo(() => {
    if (file && isTransportStream(file) && !sourcePreviewBlob) return null;
    const previewSource = sourcePreviewBlob ?? file;
    return previewSource ? URL.createObjectURL(previewSource) : null;
  }, [file, sourcePreviewBlob]);
  useEffect(() => {
    return () => {
      if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    };
  }, [sourcePreviewUrl]);

  useEffect(() => {
    let cancelled = false;
    setSourcePreviewBlob(null);
    setSourcePreviewError(null);
    setIsPreparingSourcePreview(false);
    if (!file || !isTransportStream(file)) return;

    setIsPreparingSourcePreview(true);
    remuxTsToMp4(file)
      .then((mp4) => {
        if (cancelled) return;
        setSourcePreviewBlob(new Blob([mp4 as BlobPart], { type: "video/mp4" }));
      })
      .catch((err) => {
        if (cancelled) return;
        setSourcePreviewError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setIsPreparingSourcePreview(false);
      });

    return () => {
      cancelled = true;
    };
  }, [file]);

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
    } catch {
      /* ignore */
    }
  };

  // Reseek previews when the active segment changes.
  useEffect(() => {
    if (!sourcePreviewUrl) return;
    seekTo(startVideoRef, segments[activeSeg].start);
    seekTo(endVideoRef, segments[activeSeg].end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSeg, sourcePreviewUrl]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-md bg-primary text-primary-foreground grid place-items-center">
              <Scissors className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Video Cutter &amp; Auto-Subtitler Pro</h1>
              <p className="text-xs text-muted-foreground">Browser-based · Luxembourgish (LuxASR)</p>
            </div>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            {/*
            <Link to="/studio" className="px-3 py-1.5 rounded-md hover:bg-muted flex items-center gap-1.5">
              <Radio className="h-4 w-4" /> Studio
            </Link>
            */}
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
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">1. Source video</CardTitle>
            </CardHeader>
            <CardContent>
              <label
                htmlFor="video-input"
                className="flex flex-col items-center justify-center border-2 border-dashed rounded-lg py-8 cursor-pointer hover:bg-muted/40 transition-colors"
              >
                {loadingRecording ? (
                  <Loader2 className="h-6 w-6 mb-2 text-muted-foreground animate-spin" />
                ) : (
                  <Upload className="h-6 w-6 mb-2 text-muted-foreground" />
                )}
                <p className="text-sm text-center px-4 break-all">
                  {loadingRecording
                    ? (recordingLoadLabel ?? "Loading recording…")
                    : file
                      ? (sourceTitle ?? file.name)
                      : "Click or drop a video file"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">MP4 / MKV / MOV / TS · recommended ≤ 500 MB</p>
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
                      setRecordingId(null);
                      handledRecordingRef.current = null;
                      // Drop ?recording=<id> from the URL so the effect
                      // above doesn't immediately re-load the recording
                      // and overwrite the file the user just picked.
                      if (search.recording) {
                        navigate({ to: "/", search: {}, replace: true });
                      }
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
              {isPreparingSourcePreview && (
                <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" /> Preparing source preview…
                </p>
              )}
              {sourcePreviewError && (
                <p className="text-xs text-destructive mt-2">Source preview failed: {sourcePreviewError}</p>
              )}
            </CardContent>
          </Card>

          {/*
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Camera className="h-4 w-4" /> Live snapshot from HLS
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Saves everything the shared recorder has buffered <b>since it started</b> (or since your last snapshot) straight to <b>Recordings</b>. Uses the same stream URL as Studio — no need to open the Studio tab.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="snap-url">HLS playlist URL</Label>
                <Input
                  id="snap-url"
                  value={snapshotUrl}
                  onChange={(e) => setSnapshotUrl(e.target.value)}
                  disabled={snapshotBusy}
                  placeholder="https://…/playlist.m3u8"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground font-mono">
                  {sharedInfo && sharedInfo.url === snapshotUrl ? (
                    <>
                      ● Buffered: {sharedInfo.bufferedSegments - sharedInfo.cursor} new segment
                      {sharedInfo.bufferedSegments - sharedInfo.cursor === 1 ? "" : "s"} · since{" "}
                      {sharedInfo.startedAt.toLocaleTimeString()}
                    </>
                  ) : (
                    <>○ Recorder idle — first snapshot will start it</>
                  )}
                </div>
                <Button onClick={runSnapshot} disabled={snapshotBusy || !snapshotUrl}>
                  {snapshotBusy ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…</>
                  ) : (
                    <><Camera className="h-4 w-4 mr-2" /> Snapshot</>
                  )}
                </Button>
              </div>
              {snapshotBusy && snapshotProgress && (
                <p className="text-xs text-muted-foreground font-mono truncate">{snapshotProgress}</p>
              )}
            </CardContent>
          </Card>
        */}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <span>Find cut points via transcript</span>
                <Button size="sm" variant="outline" disabled={!file || isRunning} onClick={transcribeForCuts}>
                  {isRunning &&
                  (stage === "extracting" || stage === "asr" || stage === "srt" || stage === "shortening") ? (
                    <>
                      <Loader2 className="h-3 w-3 mr-2 animate-spin" /> Transcribing…
                    </>
                  ) : (
                    <>
                      <FileText className="h-3 w-3 mr-2" /> Transcribe
                    </>
                  )}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {cues.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Transcribes the <strong>entire</strong> video (no cutting) so you can browse subtitle blocks with
                  timestamps. Click any block to jump the previews, use its buttons to set Start / End on the cut range
                  above, or tick the checkbox on multiple blocks and use <strong>Cut selected</strong> to build a video
                  from only those blocks (with subtitles).
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-2 text-xs">
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={selectAllCues}>
                        Select all
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={clearSelectedCues}>
                        Clear
                      </Button>
                      <span className="text-muted-foreground">
                        {selectedCues.size} / {cues.length} selected
                      </span>
                    </div>
                    <Button
                      size="sm"
                      disabled={!file || isRunning || selectedCues.size === 0}
                      onClick={cutFromSelectedCues}
                    >
                      {isRunning && (stage === "cutting" || stage === "burning") ? (
                        <>
                          <Loader2 className="h-3 w-3 mr-2 animate-spin" /> Cutting…
                        </>
                      ) : (
                        <>
                          <Scissors className="h-3 w-3 mr-2" /> Cut selected ({selectedCues.size})
                        </>
                      )}
                    </Button>
                  </div>
                  <ScrollArea className="h-72 rounded-md border">
                    <ul className="divide-y">
                      {cues.map((c) => {
                        const isSelected = selectedCues.has(c.index);
                        const cx = c.xPct ?? subX;
                        const cy = c.yPct ?? subY;
                        const hasOverride = typeof c.xPct === "number" || typeof c.yPct === "number";
                        return (
                          <li key={c.index} className="p-2 hover:bg-muted/40 group">
                            <div className="flex items-center gap-2 mb-1">
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() => toggleCue(c.index)}
                                aria-label={`Select block ${c.index}`}
                              />
                              <button
                                type="button"
                                className="text-[11px] font-mono text-primary hover:underline"
                                onClick={() => seekTo(startVideoRef, formatSeconds(c.start))}
                                title="Preview at this timestamp"
                              >
                                {formatSeconds(c.start)} – {formatSeconds(c.end)}
                              </button>
                              {hasOverride && (
                                <span className="text-[10px] font-mono px-1.5 rounded bg-primary/15 text-primary">
                                  pos {Math.round(cx)},{Math.round(cy)}
                                </span>
                              )}
                              <div className="ml-auto flex gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-[11px]"
                                  onClick={() => setStartFromSeconds(c.start)}
                                >
                                  ▸ Start
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-[11px]"
                                  onClick={() => setEndFromSeconds(c.end)}
                                >
                                  End ◂
                                </Button>
                              </div>
                            </div>
                            <Textarea
                              value={c.text}
                              onChange={(e) => updateCueText(c.index, e.target.value)}
                              rows={Math.min(6, Math.max(2, c.text.split(/\n/).length))}
                              className="text-xs leading-snug ml-6 font-mono resize-y min-h-[44px]"
                              placeholder="Subtitle text (use new lines to stack phrases)"
                            />
                            <p className="text-[10px] text-muted-foreground pl-6 mt-1">
                              Edited text is used automatically when you cut or burn subtitles.
                            </p>
                            {isSelected && (
                              <div className="mt-2 pl-6 space-y-2 rounded-md border bg-muted/20 p-2">
                                <div className="flex items-center justify-between">
                                  <span className="text-[11px] text-muted-foreground">
                                    Subtitle position for this block
                                  </span>
                                  {hasOverride && (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="h-6 px-2 text-[11px]"
                                      onClick={() => resetCuePos(c.index)}
                                    >
                                      Reset to default
                                    </Button>
                                  )}
                                </div>
                                <SubtitlePreview
                                  xPct={cx}
                                  yPct={cy}
                                  fontSize={Math.min(fontSize, 28)}
                                  outline={subOutline}
                                  sample={c.text.split(/\r?\n/)[0].slice(0, 60) || "…"}
                                  onChange={(x, y) => updateCuePos(c.index, { xPct: x, yPct: y })}
                                />
                                <div className="grid grid-cols-2 gap-2">
                                  <div>
                                    <div className="flex items-center justify-between">
                                      <Label className="text-[11px]">X</Label>
                                      <span className="text-[11px] text-muted-foreground">{Math.round(cx)}%</span>
                                    </div>
                                    <Slider
                                      min={0}
                                      max={100}
                                      step={1}
                                      value={[Math.round(cx)]}
                                      onValueChange={(v) => updateCuePos(c.index, { xPct: v[0] })}
                                    />
                                  </div>
                                  <div>
                                    <div className="flex items-center justify-between">
                                      <Label className="text-[11px]">Y</Label>
                                      <span className="text-[11px] text-muted-foreground">{Math.round(cy)}%</span>
                                    </div>
                                    <Slider
                                      min={0}
                                      max={100}
                                      step={1}
                                      value={[Math.round(cy)]}
                                      onValueChange={(v) => updateCuePos(c.index, { yPct: v[0] })}
                                    />
                                  </div>
                                </div>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </ScrollArea>
                </>
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
                <div className="space-y-3">
                  <div className="flex items-center gap-1 flex-wrap">
                    {segments.map((_, i) => (
                      <div key={i} className="flex items-center">
                        <Button
                          type="button"
                          size="sm"
                          variant={i === activeSeg ? "default" : "outline"}
                          className="h-7 rounded-r-none"
                          onClick={() => setActiveSeg(i)}
                        >
                          Segment {i + 1}
                        </Button>
                        {segments.length > 1 && (
                          <Button
                            type="button"
                            size="sm"
                            variant={i === activeSeg ? "default" : "outline"}
                            className="h-7 rounded-l-none border-l-0 px-2"
                            onClick={() => removeSeg(i)}
                            title="Remove segment"
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    ))}
                    <Button type="button" size="sm" variant="ghost" className="h-7" onClick={addSeg}>
                      + Add segment
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="start">Start</Label>
                      <Input
                        id="start"
                        value={segments[activeSeg].start}
                        onChange={(e) => updateSeg(activeSeg, { start: e.target.value })}
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
                            onLoadedMetadata={() => seekTo(startVideoRef, segments[activeSeg].start)}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="w-full h-7 text-xs"
                            onClick={() => seekTo(startVideoRef, segments[activeSeg].start)}
                          >
                            <Play className="h-3 w-3 mr-1" /> Preview start
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="end">End</Label>
                      <Input
                        id="end"
                        value={segments[activeSeg].end}
                        onChange={(e) => updateSeg(activeSeg, { end: e.target.value })}
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
                            onLoadedMetadata={() => seekTo(endVideoRef, segments[activeSeg].end)}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="w-full h-7 text-xs"
                            onClick={() => seekTo(endVideoRef, segments[activeSeg].end)}
                          >
                            <Play className="h-3 w-3 mr-1" /> Preview end
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>

                  {segments.length > 1 && (
                    <ul className="text-xs font-mono border rounded-md divide-y">
                      {segments.map((s, i) => (
                        <li
                          key={i}
                          className={
                            "px-2 py-1 flex justify-between cursor-pointer " +
                            (i === activeSeg ? "bg-muted" : "hover:bg-muted/40")
                          }
                          onClick={() => setActiveSeg(i)}
                        >
                          <span>#{i + 1}</span>
                          <span>
                            {s.start} → {s.end}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="text-xs">
                    {durationInfo.ok ? (
                      <span className="text-muted-foreground">
                        Total duration ({segments.length} segment{segments.length === 1 ? "" : "s"}):{" "}
                        <span className="font-mono">{durationInfo.label}</span>
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
                    <Slider min={14} max={64} step={1} value={[fontSize]} onValueChange={(v) => setFontSize(v[0])} />
                  </div>

                  <div>
                    <div className="flex items-center justify-between">
                      <Label>Subtitle position &amp; outline</Label>
                      <span className="text-xs text-muted-foreground">
                        x {subX}% · y {subY}% · outline {subOutline}px
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">
                      Zeih den Text am Preview, oder benotz d'Sliders. Iwwerholl gëtt op déi geschnidde Videosgréisst
                      berechent.
                    </p>
                    <SubtitlePreview
                      xPct={subX}
                      yPct={subY}
                      fontSize={fontSize}
                      outline={subOutline}
                      onChange={(x, y) => {
                        setSubX(x);
                        setSubY(y);
                      }}
                    />
                    <div className="mt-3 space-y-3">
                      <div>
                        <div className="flex items-center justify-between">
                          <Label className="text-xs">Horizontal (X)</Label>
                          <span className="text-xs text-muted-foreground">{subX}%</span>
                        </div>
                        <Slider min={0} max={100} step={1} value={[subX]} onValueChange={(v) => setSubX(v[0])} />
                      </div>
                      <div>
                        <div className="flex items-center justify-between">
                          <Label className="text-xs">Vertikal (Y)</Label>
                          <span className="text-xs text-muted-foreground">{subY}%</span>
                        </div>
                        <Slider min={0} max={100} step={1} value={[subY]} onValueChange={(v) => setSubY(v[0])} />
                      </div>
                      <div>
                        <div className="flex items-center justify-between">
                          <Label className="text-xs">Schwaarze Bord (Outline)</Label>
                          <span className="text-xs text-muted-foreground">{subOutline}px</span>
                        </div>
                        <Slider
                          min={0}
                          max={8}
                          step={1}
                          value={[subOutline]}
                          onValueChange={(v) => setSubOutline(v[0])}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="maxSent">Max sentences / cue</Label>
                      <Input
                        id="maxSent"
                        type="number"
                        min={1}
                        max={5}
                        value={maxSentences}
                        onChange={(e) => setMaxSentences(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="maxChars">Max chars / cue</Label>
                      <Input
                        id="maxChars"
                        type="number"
                        min={30}
                        max={200}
                        value={maxChars}
                        onChange={(e) => setMaxChars(Math.max(30, Number(e.target.value) || 30))}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <Label htmlFor="burn">Burn subtitles into video</Label>
                      <p className="text-xs text-muted-foreground">Off = SRT file only (faster)</p>
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
                      {[
                        { v: 0 as const, label: "Source" },
                        { v: 480 as const, label: "480p" },
                        { v: 720 as const, label: "720p" },
                        { v: 1080 as const, label: "1080p" },
                      ].map((o) => (
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
                <Button onClick={run} disabled={!canRun} className="flex-1" size="lg">
                  {isRunning ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Running…
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 mr-2" /> Run
                    </>
                  )}
                </Button>
                {isRunning && (
                  <Button onClick={cancel} variant="destructive" size="lg">
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
                <Button variant="outline" size="sm" disabled={!clipBlob} onClick={() => download(clipBlob, "clip.mp4")}>
                  <Download className="h-4 w-4 mr-2" /> clip.mp4
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!audioBlob}
                  onClick={() => download(audioBlob, "clip.mp3")}
                >
                  <Download className="h-4 w-4 mr-2" /> clip.mp3
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!srtText}
                  onClick={() =>
                    download(srtText ? new Blob([srtText], { type: "text/plain" }) : null, "subtitles.srt")
                  }
                >
                  <Download className="h-4 w-4 mr-2" /> subtitles.srt
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!subbedBlob}
                  onClick={() => download(subbedBlob, "clip_subbed.mp4")}
                >
                  <Download className="h-4 w-4 mr-2" /> clip_subbed.mp4
                </Button>
              </div>

              {srtText && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Preview SRT</summary>
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
        Processing runs entirely in your browser via ffmpeg.wasm. Only the extracted audio is sent to LuxASR (uni.lu)
        for transcription. Keep this tab open while jobs run.
      </footer>
    </div>
  );
}

function PipelineStepper({
  current,
  progress,
  mode,
  burnIn,
}: {
  current: Stage;
  progress: number;
  mode: Mode;
  burnIn: boolean;
}) {
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
              {i < active.length - 1 && <div className="w-4 h-px bg-border" />}
            </div>
          );
        })}
      </div>
      {current !== "idle" && current !== "done" && current !== "error" && (
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {current === "idle" && (
        <p className="text-xs text-muted-foreground">
          Upload a video and click <span className="font-medium">Run</span>.
        </p>
      )}
      {current === "done" && <p className="text-xs text-primary">Done — download your files below.</p>}
    </div>
  );
}
