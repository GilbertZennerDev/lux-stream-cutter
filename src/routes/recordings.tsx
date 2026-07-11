import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Library, Scissors, Radio, Download, Trash2, ArrowRight, Loader2, Film, Upload, Play, FileText, Search, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  listRecordings,
  deleteRecording,
  getRecordingDownloadUrl,
  createRecording,
  markRecordingReady,
  markRecordingFailed,
  type RecordingRow,
} from "@/lib/recordings.functions";
import { TranscriptEditor } from "@/components/recordings/TranscriptEditor";
import { RecordingThumbnail, setThumbnail, generateThumbnailFromBlob } from "@/components/recordings/RecordingThumbnail";
import { mergeRecordings } from "@/lib/recordings/mergeChunks";
import { setPendingSource } from "@/lib/session/pendingSource";



const RECORDINGS_BUCKET = "recordings";

export const Route = createFileRoute("/recordings")({
  head: () => ({
    meta: [
      { title: "Recordings · LuxStream" },
      { name: "description", content: "Recorded Chamber TV sessions, grouped by day." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RecordingsPage,
});

function RecordingsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["recordings"],
    queryFn: () => listRecordings(),
    refetchInterval: 15000,
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteRecording({ data: { id } }),
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["recordings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dl = useMutation({
    mutationFn: async (r: RecordingRow) => {
      const { url } = await getRecordingDownloadUrl({ data: { id: r.id } });
      const a = document.createElement("a");
      a.href = url;
      a.download = r.storage_path.split("/").pop() ?? "recording.ts";
      // Signed URLs are cross-origin; some browsers ignore `download` there
      // and open in-tab. Force a new tab so at minimum something happens.
      a.rel = "noopener";
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openInCutter = (r: RecordingRow) => {
    navigate({ to: "/", search: { recording: r.id } });
  };

  const [preview, setPreview] = useState<{ url: string; title: string; remuxing?: boolean; error?: string } | null>(null);
  const [transcriptFor, setTranscriptFor] = useState<{ id: string; title: string } | null>(null);

  const previewMut = useMutation({
    mutationFn: async (r: RecordingRow) => {
      const name = r.storage_path.split("/").pop() ?? "Recording";
      const title = r.title ?? name;
      // Open the dialog immediately so the user gets instant feedback
      // instead of waiting silently on the signed-URL round-trip + remux.
      setPreview({ url: "", title, remuxing: true });
      const { url } = await getRecordingDownloadUrl({ data: { id: r.id } });
      const isTs = /\.ts$/i.test(r.storage_path);
      if (!isTs) {
        setPreview({ url, title });
        return;
      }
      // Browsers can't play raw MPEG-TS via <video>. Remux to MP4 client-side.
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        const blob = await res.blob();
        const { remuxTsToMp4 } = await import("@/lib/ffmpeg/operations");
        const mp4 = await remuxTsToMp4(blob);
        const mp4Url = URL.createObjectURL(new Blob([mp4 as BlobPart], { type: "video/mp4" }));
        setPreview({ url: mp4Url, title });
      } catch (err) {
        // Fall back to the raw signed URL — Safari can play TS natively;
        // other browsers will show an unplayable-media error, both better
        // than a silent infinite spinner.
        setPreview({ url, title, error: (err as Error).message });
        throw err;
      }
    },
    onError: (e: Error) => toast.error(`Preview failed: ${e.message}`),
  });



  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; done: number; total: number } | null>(null);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const rows = data ?? [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const now = new Date();
        const sessionDate = new Date(file.lastModified || now).toISOString().slice(0, 10);
        const existingForDate = rows.filter((r) => r.session_date === sessionDate);
        const maxIdx = existingForDate.reduce((m, r) => Math.max(m, r.chunk_index), -1);
        const chunkIndex = maxIdx + 1 + i;
        const ext = (file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "mp4";
        setUploadProgress({ name: file.name, done: i, total: files.length });
        const created = await createRecording({
          data: {
            sessionDate,
            chunkIndex,
            startedAt: new Date(file.lastModified || now).toISOString(),
            title: file.name,
            fileExt: ext,
          },
        });
        try {
          const { error } = await supabase.storage
            .from(RECORDINGS_BUCKET)
            .uploadToSignedUrl(created.path, created.token, file, {
              contentType: file.type || "video/mp4",
            });
          if (error) throw error;
          await markRecordingReady({
            data: {
              id: created.id,
              endedAt: new Date().toISOString(),
              sizeBytes: file.size,
            },
          });
          // Generate the thumbnail from the local file — no re-download.
          // Skip .ts (browsers can't decode MPEG-TS in <video>).
          if (!/\.(ts)$/i.test(file.name)) {
            generateThumbnailFromBlob(file)
              .then((url) => {
                if (url) setThumbnail(created.id, url);
              })
              .catch(() => {});
          }
        } catch (err) {
          await markRecordingFailed({
            data: { id: created.id, error: (err as Error).message.slice(0, 500) },
          }).catch(() => {});
          throw err;
        }
      }
    },
    onSuccess: (_, files) => {
      toast.success(`Uploaded ${files.length} file${files.length === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["recordings"] });
    },
    onError: (e: Error) => toast.error(`Upload failed: ${e.message}`),
    onSettled: () => setUploadProgress(null),
  });

  const onFilesPicked = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list).filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|mkv|webm|ts|m4v|avi)$/i.test(f.name));
    if (files.length === 0) {
      toast.error("Please select video files");
      return;
    }
    upload.mutate(files);
  };

  // Multi-select + search for bulk actions.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeLabel, setMergeLabel] = useState("");

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const clearSelected = () => setSelected(new Set());

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = data ?? [];
    if (!q) return rows;
    return rows.filter((r) => {
      if (r.title?.toLowerCase().includes(q)) return true;
      if (r.storage_path.toLowerCase().includes(q)) return true;
      if (r.session_date.includes(q)) return true;
      if (r.transcript?.some((c) => c.text.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [data, query]);

  const grouped = groupBySession(filteredRows);

  const selectedRows = useMemo(
    () => (data ?? []).filter((r) => selected.has(r.id) && r.status === "ready"),
    [data, selected],
  );

  const selectWholeSession = (group: Group) => {
    setSelected((prev) => {
      const n = new Set(prev);
      const readyIds = group.rows.filter((r) => r.status === "ready").map((r) => r.id);
      const allIn = readyIds.every((id) => n.has(id));
      if (allIn) readyIds.forEach((id) => n.delete(id));
      else readyIds.forEach((id) => n.add(id));
      return n;
    });
  };

  const cutMerged = async () => {
    if (selectedRows.length === 0) return;
    if (selectedRows.length === 1) {
      openInCutter(selectedRows[0]);
      clearSelected();
      return;
    }
    setMergeBusy(true);
    const t = toast.loading(`Merging ${selectedRows.length} chunks…`);
    try {
      const { file, cues, title } = await mergeRecordings(selectedRows, (label, done, total) => {
        setMergeLabel(`${label} (${done}/${total})`);
      });
      const id = setPendingSource({ file, cues, title });
      toast.success(`Merged ${selectedRows.length} chunks → opening in Cutter`, { id: t });
      clearSelected();
      navigate({ to: "/", search: { pending: id } });
    } catch (err) {
      toast.error((err as Error).message, { id: t });
    } finally {
      setMergeBusy(false);
      setMergeLabel("");
    }
  };

  const downloadSelected = async () => {
    for (const r of selectedRows) {
      dl.mutate(r);
      await new Promise((res) => setTimeout(res, 300));
    }
  };

  const deleteSelected = () => {
    if (selectedRows.length === 0) return;
    if (!confirm(`Delete ${selectedRows.length} recording${selectedRows.length === 1 ? "" : "s"}?`)) return;
    selectedRows.forEach((r) => del.mutate(r.id));
    clearSelected();
  };


  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-md bg-primary text-primary-foreground grid place-items-center">
              <Library className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Recordings library</h1>
              <p className="text-xs text-muted-foreground">
                Every 5-minute chunk from scheduled recordings. Kept 30 days.
              </p>
            </div>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            <Link to="/" className="px-3 py-1.5 rounded-md hover:bg-muted flex items-center gap-1.5">
              <Scissors className="h-4 w-4" /> Cutter
            </Link>
            <Link to="/studio" className="px-3 py-1.5 rounded-md hover:bg-muted flex items-center gap-1.5">
              <Radio className="h-4 w-4" /> Studio
            </Link>
            <Link to="/premiere" className="px-3 py-1.5 rounded-md hover:bg-muted flex items-center gap-1.5">
              <Film className="h-4 w-4" /> Premiere
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6 space-y-6">
        <div
          className="flex items-center justify-between gap-3 flex-wrap"
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            onFilesPicked(e.dataTransfer.files);
          }}
        >
          <div className="text-sm text-muted-foreground">
            {data
              ? `${filteredRows.length}${query ? ` / ${data.length}` : ""} chunk${filteredRows.length === 1 ? "" : "s"}`
              : "…"}
            {uploadProgress && (
              <span className="ml-2">
                · Uploading {uploadProgress.done + 1}/{uploadProgress.total}: {uploadProgress.name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title, date, transcript…"
                className="pl-7 h-8 w-64 text-sm"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,.ts,.mkv"
              multiple
              className="hidden"
              onChange={(e) => {
                onFilesPicked(e.target.files);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            />
            <Button
              variant="default"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={upload.isPending}
            >
              {upload.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin mr-2" />
              ) : (
                <Upload className="h-3 w-3 mr-2" />
              )}
              Upload video
            </Button>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="h-3 w-3 animate-spin mr-2" /> : null}
              Refresh
            </Button>
          </div>
        </div>

        {/* Sticky bulk-action bar — appears only when something is selected. */}
        {selectedRows.length > 0 && (
          <div className="sticky top-0 z-10 -mx-6 px-6 py-2 bg-background/95 backdrop-blur border-b flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium">
              {selectedRows.length} selected
              {mergeLabel && <span className="ml-2 text-xs text-muted-foreground font-mono">· {mergeLabel}</span>}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" onClick={cutMerged} disabled={mergeBusy}>
                {mergeBusy ? (
                  <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                ) : (
                  <Scissors className="h-3 w-3 mr-2" />
                )}
                {selectedRows.length === 1 ? "Open in Cutter" : `Merge & Cut (${selectedRows.length})`}
              </Button>
              <Button size="sm" variant="outline" onClick={downloadSelected} disabled={dl.isPending}>
                <Download className="h-3 w-3 mr-2" /> Download
              </Button>
              <Button size="sm" variant="ghost" onClick={deleteSelected} disabled={del.isPending}>
                <Trash2 className="h-3 w-3 mr-2" /> Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={clearSelected}>
                <X className="h-3 w-3 mr-1" /> Clear
              </Button>
            </div>
          </div>
        )}

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

        {grouped.length === 0 && !isLoading && (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No recordings yet. Open the <Link to="/studio" className="underline">Studio tab</Link> on an
              always-on machine to auto-record Tue–Thu 14:00–18:00.
            </CardContent>
          </Card>
        )}

        {grouped.map((group) => {
          const readyIds = group.rows.filter((r) => r.status === "ready").map((r) => r.id);
          const allReadySelected = readyIds.length > 0 && readyIds.every((id) => selected.has(id));
          return (
          <Card key={group.date}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-3 flex-wrap">
                <span>Session · {group.date}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {group.rows.length} chunks · {formatBytes(group.totalBytes)}
                </span>
                {readyIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => selectWholeSession(group)}
                    className="ml-auto text-[11px] px-2 py-0.5 rounded-full border hover:bg-muted transition-colors font-normal"
                  >
                    {allReadySelected ? "Deselect session" : "Select whole session"}
                  </button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y">
                {group.rows.map((r) => (
                  <div key={r.id} className={"py-2 flex items-center gap-3 " + (selected.has(r.id) ? "bg-primary/5 -mx-2 px-2 rounded" : "")}>
                    <Checkbox
                      checked={selected.has(r.id)}
                      disabled={r.status !== "ready"}
                      onCheckedChange={() => toggleSelected(r.id)}
                      aria-label={`Select chunk ${r.chunk_index}`}
                    />
                    <div className="w-16 text-xs font-mono text-muted-foreground">
                      #{String(r.chunk_index).padStart(3, "0")}
                    </div>
                    <div className="flex-1 min-w-0 flex gap-3">
                      <RecordingThumbnail
                        recordingId={r.id}
                        storagePath={r.storage_path}
                        ready={r.status === "ready"}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {r.title ?? r.storage_path.split("/").pop()}
                        </div>
                        <div className="text-xs font-mono text-muted-foreground truncate">
                          {formatTimeRange(r.started_at, r.ended_at)} · {formatBytes(r.size_bytes)}
                          {formatAudioDetails(r) && <span> · {formatAudioDetails(r)}</span>}
                          {r.error && <span className="text-destructive"> · {r.error}</span>}
                        </div>
                      </div>
                    </div>
                    {r.full_copy && <Badge variant="secondary">Full copy</Badge>}
                    {r.transcript && r.transcript.length > 0 && (
                      <Badge variant="outline" title={`${r.transcript.length} cues`}>
                        <FileText className="h-3 w-3 mr-1" /> {r.transcript.length}
                      </Badge>
                    )}
                    <StatusBadge status={r.status} />
                    <AudioBadge recording={r} />
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="default"
                        disabled={r.status !== "ready"}
                        onClick={() => openInCutter(r)}
                      >
                        <ArrowRight className="h-3 w-3 mr-1" /> Cut
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={r.status !== "ready"}
                        onClick={() =>
                          setTranscriptFor({
                            id: r.id,
                            title: r.title ?? r.storage_path.split("/").pop() ?? "Transcript",
                          })
                        }
                        title="Edit transcript"
                      >
                        <FileText className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={r.status !== "ready" || previewMut.isPending}
                        onClick={() => previewMut.mutate(r)}
                        title="Preview"
                      >
                        <Play className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={r.status !== "ready" || dl.isPending}
                        onClick={() => dl.mutate(r)}
                      >
                        <Download className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={del.isPending}
                        onClick={() => {
                          if (confirm(`Delete chunk #${r.chunk_index}?`)) del.mutate(r.id);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>

                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          );
        })}
      </main>

      <Dialog
        open={!!preview}
        onOpenChange={(o) => {
          if (!o) {
            if (preview?.url?.startsWith("blob:")) URL.revokeObjectURL(preview.url);
            setPreview(null);
          }
        }}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate">{preview?.title}</DialogTitle>
          </DialogHeader>
          {preview?.remuxing && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              Preparing preview… (fetching + remuxing .ts to MP4)
            </div>
          )}
          {preview?.error && (
            <p className="text-xs text-destructive px-1">
              Remux failed: {preview.error}. Trying raw stream — your browser may not support MPEG-TS.
            </p>
          )}
          {preview && preview.url && !preview.remuxing && (
            <video
              src={preview.url}
              controls
              autoPlay
              className="w-full max-h-[70vh] rounded-md bg-black"
            />
          )}
        </DialogContent>
      </Dialog>

      {transcriptFor && (
        <TranscriptEditor
          recordingId={transcriptFor.id}
          title={transcriptFor.title}
          open={true}
          onClose={() => setTranscriptFor(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["recordings"] })}
        />
      )}
    </div>

  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    uploading: { label: "Uploading", variant: "secondary" },
    ready: { label: "Ready", variant: "default" },
    failed: { label: "Failed", variant: "destructive" },
  };
  const m = map[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

function AudioBadge({ recording }: { recording: RecordingRow }) {
  const status = recording.audio_status;
  if (!status) return <Badge variant="outline">Audio unknown</Badge>;
  if (status === "verified") return <Badge variant="default">Audio verified</Badge>;
  if (status === "embedded") return <Badge variant="secondary">Audio embedded</Badge>;
  if (status === "missing" || status === "failed") return <Badge variant="destructive">No audio</Badge>;
  return <Badge variant="outline">Audio {status}</Badge>;
}

function formatAudioDetails(recording: RecordingRow): string | null {
  const details = recording.audio_details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const audioSegments = typeof details.capturedSegments === "number" ? details.capturedSegments : null;
  const streams = typeof details.streams === "string" ? details.streams : null;
  if (audioSegments !== null && streams) return `${audioSegments} audio segments · ${streams}`;
  if (streams) return streams;
  return null;
}

function formatBytes(n: number): string {
  if (!n) return "—";
  const mb = n / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function formatTimeRange(startIso: string, endIso: string | null): string {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Luxembourg",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d);
  const start = fmt(new Date(startIso));
  const end = endIso ? fmt(new Date(endIso)) : "…";
  return `${start} – ${end}`;
}

interface Group {
  date: string;
  rows: RecordingRow[];
  totalBytes: number;
}

function groupBySession(rows: RecordingRow[]): Group[] {
  const map = new Map<string, Group>();
  for (const r of rows) {
    let g = map.get(r.session_date);
    if (!g) {
      g = { date: r.session_date, rows: [], totalBytes: 0 };
      map.set(r.session_date, g);
    }
    g.rows.push(r);
    g.totalBytes += r.size_bytes ?? 0;
  }
  const groups = Array.from(map.values());
  groups.forEach((g) => g.rows.sort((a, b) => a.chunk_index - b.chunk_index));
  groups.sort((a, b) => (a.date < b.date ? 1 : -1));
  return groups;
}
