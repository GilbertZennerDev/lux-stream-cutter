import { useEffect, useRef, useState } from "react";
import { Film, Loader2 } from "lucide-react";
import { getRecordingDownloadUrl } from "@/lib/recordings.functions";

// Module-level cache so thumbnails persist across renders/refetches.
const cache = new Map<string, string>(); // recordingId -> object URL
const inflight = new Map<string, Promise<string | null>>();

// Limit concurrent generations so we don't hammer bandwidth / CPU.
let active = 0;
const MAX_CONCURRENT = 2;
const queue: Array<() => void> = [];
function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    queue.push(() => {
      active++;
      resolve();
    });
  });
}
function release() {
  active--;
  const next = queue.shift();
  if (next) next();
}

async function generateThumb(recordingId: string, storagePath: string): Promise<string | null> {
  const isTs = /\.ts$/i.test(storagePath);
  // Browsers can't render MPEG-TS in a <video>; skip to avoid a costly remux
  // per row. Preview button still works via the existing ffmpeg remux flow.
  if (isTs) return null;

  await acquire();
  try {
    const { url } = await getRecordingDownloadUrl({ data: { id: recordingId } });
    return await new Promise<string | null>((resolve) => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.src = url;

      let settled = false;
      const cleanup = () => {
        try {
          video.removeAttribute("src");
          video.load();
        } catch {}
      };
      const finish = (v: string | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(v);
      };

      const capture = () => {
        try {
          const w = video.videoWidth;
          const h = video.videoHeight;
          if (!w || !h) return finish(null);
          const scale = Math.min(1, 320 / w);
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext("2d");
          if (!ctx) return finish(null);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(
            (blob) => {
              if (!blob) return finish(null);
              finish(URL.createObjectURL(blob));
            },
            "image/jpeg",
            0.7,
          );
        } catch {
          finish(null);
        }
      };

      video.addEventListener("loadeddata", () => {
        // Seek slightly in to skip any black leading frame.
        try {
          video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
        } catch {
          capture();
        }
      });
      video.addEventListener("seeked", capture);
      video.addEventListener("error", () => finish(null));
      // Safety timeout — some files just won't decode in-browser.
      setTimeout(() => finish(null), 15000);
    });
  } catch {
    return null;
  } finally {
    release();
  }
}

interface Props {
  recordingId: string;
  storagePath: string;
  ready: boolean;
}

export function RecordingThumbnail({ recordingId, storagePath, ready }: Props) {
  const [src, setSrc] = useState<string | null>(() => cache.get(recordingId) ?? null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    return () => {
      cancelled.current = true;
    };
  }, []);

  const handleClick = () => {
    if (!ready || loading || src) return;
    if (/\.ts$/i.test(storagePath)) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setLoading(true);
    let promise = inflight.get(recordingId);
    if (!promise) {
      promise = generateThumb(recordingId, storagePath).then((url) => {
        if (url) cache.set(recordingId, url);
        inflight.delete(recordingId);
        return url;
      });
      inflight.set(recordingId, promise);
    }
    promise.then((url) => {
      if (cancelled.current) return;
      setLoading(false);
      if (url) setSrc(url);
      else setFailed(true);
    });
  };

  const disabled = !ready || loading || !!src;
  const title = !ready
    ? "Not ready"
    : src
      ? "First frame"
      : loading
        ? "Generating…"
        : failed
          ? /\.ts$/i.test(storagePath)
            ? "Preview not available for .ts files"
            : "Could not generate thumbnail — click to retry"
          : "Click to generate thumbnail";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={title}
      className="mt-1 h-16 w-28 shrink-0 overflow-hidden rounded border bg-muted grid place-items-center hover:bg-muted/70 disabled:cursor-default"
    >
      {src ? (
        <img src={src} alt="First frame" className="h-full w-full object-cover" />
      ) : loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <Film className="h-4 w-4 text-muted-foreground" />
      )}
    </button>
  );
}
