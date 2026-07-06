import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, Scissors, Radio, Download, Trash2, ArrowRight, Loader2, Film } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  listRecordings,
  deleteRecording,
  getRecordingDownloadUrl,
  type RecordingRow,
} from "@/lib/recordings.functions";

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
      a.click();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openInCutter = (r: RecordingRow) => {
    navigate({ to: "/", search: { recording: r.id } as never });
  };

  const grouped = groupBySession(data ?? []);

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
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            {data ? `${data.length} chunk${data.length === 1 ? "" : "s"}` : "…"}
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-3 w-3 animate-spin mr-2" /> : null}
            Refresh
          </Button>
        </div>

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

        {grouped.map((group) => (
          <Card key={group.date}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Session · {group.date}
                <span className="ml-3 text-xs font-normal text-muted-foreground">
                  {group.rows.length} chunks · {formatBytes(group.totalBytes)}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y">
                {group.rows.map((r) => (
                  <div key={r.id} className="py-2 flex items-center gap-3">
                    <div className="w-16 text-xs font-mono text-muted-foreground">
                      #{String(r.chunk_index).padStart(3, "0")}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-mono truncate">
                        {formatTimeRange(r.started_at, r.ended_at)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatBytes(r.size_bytes)}
                        {r.error && <span className="text-destructive"> · {r.error}</span>}
                      </div>
                    </div>
                    <StatusBadge status={r.status} />
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
        ))}
      </main>
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
