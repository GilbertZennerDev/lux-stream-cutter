import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

interface Props {
  url: string;
  active: boolean;
  intervalMs?: number;
}

function proxied(url: string) {
  return `/api/hls-proxy?url=${encodeURIComponent(url)}`;
}

export function LivePreview({ url, active, intervalMs = 10000 }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Attach HLS
  useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    const src = proxied(url);
    let hls: Hls | null = null;

    if (Hls.isSupported()) {
      hls = new Hls({ liveDurationInfinity: true, lowLatencyMode: true });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setError(data.details || "HLS error");
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
    } else {
      setError("HLS not supported in this browser");
      return;
    }
    video.muted = true;
    video.play().catch(() => {});

    return () => {
      try { hls?.destroy(); } catch {}
      try { video.pause(); video.removeAttribute("src"); video.load(); } catch {}
    };
  }, [url, active]);

  // Capture frame periodically
  useEffect(() => {
    if (!active) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    let prevUrl: string | null = null;

    const capture = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) return;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (cancelled || !blob) return;
          const nextUrl = URL.createObjectURL(blob);
          setSnapshot((old) => {
            if (old) URL.revokeObjectURL(old);
            return nextUrl;
          });
          if (prevUrl) URL.revokeObjectURL(prevUrl);
          prevUrl = nextUrl;
          setUpdatedAt(new Date());
        },
        "image/jpeg",
        0.7,
      );
    };

    // First shot as soon as we have a frame
    const initial = setInterval(() => {
      const v = videoRef.current;
      if (v && v.readyState >= 2 && v.videoWidth) {
        capture();
        clearInterval(initial);
      }
    }, 500);

    const id = setInterval(capture, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearInterval(initial);
      setSnapshot((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
    };
  }, [active, intervalMs]);

  return (
    <div className="space-y-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-black">
        {snapshot ? (
          <img src={snapshot} alt="Live preview frame" className="h-full w-full object-contain" />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            {active ? (error ?? "Waiting for first frame…") : "Preview idle"}
          </div>
        )}
        <video ref={videoRef} className="hidden" playsInline muted />
      </div>
      <div className="text-xs text-muted-foreground">
        {active
          ? updatedAt
            ? `Updated ${updatedAt.toLocaleTimeString()} · refreshes every ${Math.round(intervalMs / 1000)}s`
            : "Connecting…"
          : "Start recording to see a preview"}
      </div>
    </div>
  );
}
