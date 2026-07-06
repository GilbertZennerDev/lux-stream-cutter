import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Radio, Square, Loader2, Calendar, Scissors, Library } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
  nextSessionWindow,
  isInSession,
  formatLuxTime,
  formatDurationMs,
  SCHEDULE,
} from "@/lib/schedule";
import {
  startScheduledRecording,
  type ScheduledRecorderHandle,
} from "@/lib/hls/scheduled-recorder";

const DEFAULT_URL =
  "https://media02.webtvlive.eu/chd-edge/smil:chamber_tv_hd.smil/playlist.m3u8";

export const Route = createFileRoute("/studio")({
  head: () => ({
    meta: [
      { title: "Studio · LuxStream Recorder" },
      {
        name: "description",
        content:
          "Keep this tab open on an always-on machine to auto-record Chamber TV on Tuesdays, Wednesdays, and Thursdays.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Studio,
});

function Studio() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [autoMode, setAutoMode] = useState(true);
  const [logs, setLogs] = useState<string[]>([]);
  const [chunkCount, setChunkCount] = useState(0);
  const [recording, setRecording] = useState(false);
  const [now, setNow] = useState(new Date());
  const handleRef = useRef<ScheduledRecorderHandle | null>(null);
  const currentSessionRef = useRef<string | null>(null);

  const appendLog = useCallback((msg: string) => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${msg}`;
    setLogs((l) => (l.length > 400 ? [...l.slice(-400), stamped] : [...l, stamped]));
  }, []);

  // 1s tick
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const sessionWindow = useMemo(() => nextSessionWindow(now), [now]);
  const inSession = useMemo(() => isInSession(now), [now]);

  const startNow = useCallback(
    (sessionDate: string) => {
      if (handleRef.current) return;
      currentSessionRef.current = sessionDate;
      appendLog(`Starting recording for session ${sessionDate}`);
      handleRef.current = startScheduledRecording({
        playlistUrl: url,
        sessionDate,
        chunkMs: 5 * 60 * 1000,
        onLog: appendLog,
        onChunkReady: ({ chunkIndex }) => setChunkCount(chunkIndex + 1),
        onChunkError: (m) => appendLog(`ERR: ${m}`),
      });
      setRecording(true);
      setChunkCount(1);
    },
    [url, appendLog],
  );

  const stopNow = useCallback(async () => {
    const h = handleRef.current;
    if (!h) return;
    handleRef.current = null;
    currentSessionRef.current = null;
    appendLog("Stopping recording…");
    await h.stop();
    setRecording(false);
    appendLog("Stopped");
    toast.success("Recording stopped");
  }, [appendLog]);

  // Auto-start / auto-stop based on schedule
  useEffect(() => {
    if (!autoMode) return;
    if (inSession && !handleRef.current) {
      startNow(inSession.sessionDate);
    } else if (!inSession && handleRef.current) {
      stopNow();
    }
  }, [autoMode, inSession, startNow, stopNow]);

  // Prevent accidental navigation while recording
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (handleRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  const untilStart = window.start.getTime() - now.getTime();
  const untilEnd = window.end.getTime() - now.getTime();
  const elapsed = inSession ? now.getTime() - inSession.start.getTime() : 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-md bg-primary text-primary-foreground grid place-items-center">
              <Radio className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Studio</h1>
              <p className="text-xs text-muted-foreground">
                Auto-records Chamber TV · Tue–Thu 14:00–18:00 (Luxembourg)
              </p>
            </div>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            <Link to="/" className="px-3 py-1.5 rounded-md hover:bg-muted flex items-center gap-1.5">
              <Scissors className="h-4 w-4" /> Cutter
            </Link>
            <Link to="/recordings" className="px-3 py-1.5 rounded-md hover:bg-muted flex items-center gap-1.5">
              <Library className="h-4 w-4" /> Recordings
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6 space-y-6">
        <Alert>
          <Calendar className="h-4 w-4" />
          <AlertTitle>Keep this tab open on an always-on machine</AlertTitle>
          <AlertDescription>
            Recording happens in this browser tab. If the tab is closed or the machine sleeps,
            the recording stops. Uploads go to Lovable Cloud storage; the Recordings library
            shows every chunk as it's finished.
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Schedule</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            <StatCard
              label={inSession ? "Session ends in" : "Next session"}
              value={inSession ? formatDurationMs(untilEnd) : formatLuxTime(window.start)}
              hint={
                inSession
                  ? `Started ${formatLuxTime(inSession.start)}`
                  : `Starts in ${formatDurationMs(untilStart)}`
              }
              highlight={!!inSession}
            />
            <StatCard
              label="Session date"
              value={window.sessionDate}
              hint={`${SCHEDULE.startHour}:00 – ${SCHEDULE.endHour}:00 Europe/Luxembourg`}
            />
            <StatCard
              label={recording ? "Recording" : "Idle"}
              value={recording ? formatDurationMs(elapsed) : "—"}
              hint={`${chunkCount} chunk${chunkCount === 1 ? "" : "s"} started`}
              highlight={recording}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Source & controls</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="hls">HLS playlist URL</Label>
              <Input
                id="hls"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={recording}
              />
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={autoMode}
                  onChange={(e) => setAutoMode(e.target.checked)}
                  className="h-4 w-4"
                />
                Auto-record on schedule (Tue–Thu 14:00–18:00)
              </label>
            </div>

            <div className="flex gap-2 flex-wrap">
              {!recording ? (
                <Button
                  onClick={() =>
                    startNow(inSession?.sessionDate ?? window.sessionDate)
                  }
                >
                  <Radio className="h-4 w-4 mr-2" /> Start now
                </Button>
              ) : (
                <Button onClick={stopNow} variant="destructive">
                  <Square className="h-4 w-4 mr-2" /> Stop
                </Button>
              )}
              {autoMode && !recording && (
                <span className="text-xs text-muted-foreground self-center inline-flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Waiting for {formatLuxTime(window.start)}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Log</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64 rounded border bg-muted/30 p-3">
              <pre className="text-xs font-mono whitespace-pre-wrap">
                {logs.join("\n") || "No activity yet."}
              </pre>
            </ScrollArea>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function StatCard({
  label, value, hint, highlight,
}: { label: string; value: string; hint?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${highlight ? "border-primary bg-primary/5" : ""}`}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-2xl font-mono mt-1">{value}</div>
      {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}
