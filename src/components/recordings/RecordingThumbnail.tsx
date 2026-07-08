import { useEffect, useRef, useState } from "react";
import { Film, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getRecordingDownloadUrl } from "@/lib/recordings.functions";

// Module-level cache so thumbnails persist across renders/refetches.
const cache = new Map<string, string>(); // recordingId -> object URL
const inflight = new Map<string, Promise<string | null>>();
const listeners = new Map<string, Set<(url: string) => void>>();

function notify(recordingId: string, url: string) {
  const set = listeners.get(recordingId);
  if (!set) return;
  for (const cb of set) cb(url);
}

/** Store a pre-generated thumbnail (e.g. captured during upload). */
export function setThumbnail(recordingId: string, url: string) {
  const prev = cache.get(recordingId);
  if (prev && prev !== url) URL.revokeObjectURL(prev);
  cache.set(recordingId, url);
  notify(recordingId, url);
}

/** Generate a thumbnail from a local File / Blob (no network). */
export async function generateThumbnailFromBlob(blob: Blob): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const objectUrl = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;

    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(objectUrl);
      try {
        video.removeAttribute("src");
        video.load();
      } catch {}
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
          (out) => finish(out ? URL.createObjectURL(out) : null),
          "image/jpeg",
          0.7,
        );
      } catch {
        finish(null);
      }
    };
    video.addEventListener("loadeddata", () => {
      try {
        video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
      } catch {
        capture();
      }
    });
    video.addEventListener("seeked", capture);
    video.addEventListener("error", () => finish(null));
    setTimeout(() => finish(null), 15000);
  });
}
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
  if (isTs) throw new Error("Preview not available for .ts files");

  await acquire();
  try {
    const { url } = await getRecordingDownloadUrl({ data: { id: recordingId } });
    // Fetch the file so the canvas isn't tainted by cross-origin drawing.
    // Range request keeps this cheap — most containers have moov near the head.
    let blob: Blob;
    try {
      const res = await fetch(url, { headers: { Range: "bytes=0-4194304" } });
      if (!res.ok && res.status !== 206) throw new Error(`Fetch ${res.status}`);
      blob = await res.blob();
    } catch {
      // Fallback: full file
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      blob = await res.blob();
    }
    const thumb = await generateThumbnailFromBlob(blob);
    if (!thumb) throw new Error("Could not decode video for thumbnail");
    return thumb;
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
    cancelled.current = false;
    // Pick up thumbnails set from elsewhere (e.g. right after an upload).
    const cached = cache.get(recordingId);
    if (cached && cached !== src) setSrc(cached);
    let set = listeners.get(recordingId);
    if (!set) {
      set = new Set();
      listeners.set(recordingId, set);
    }
    const cb = (url: string) => {
      if (!cancelled.current) setSrc(url);
    };
    set.add(cb);
    return () => {
      cancelled.current = true;
      set!.delete(cb);
      if (set!.size === 0) listeners.delete(recordingId);
    };
  }, [recordingId, src]);

  const handleClick = () => {
    if (!ready || loading || src) return;
    if (/\.ts$/i.test(storagePath)) {
      setFailed(true);
      toast.error("Thumbnails not supported for .ts files (browser can't decode MPEG-TS).");
      return;
    }
    setFailed(false);
    setLoading(true);
    let promise = inflight.get(recordingId);
    if (!promise) {
      promise = generateThumb(recordingId, storagePath)
        .then((url) => {
          if (url) cache.set(recordingId, url);
          inflight.delete(recordingId);
          return url;
        })
        .catch((err: Error) => {
          console.error("[thumbnail] generation failed", err);
          toast.error(`Thumbnail failed: ${err.message}`);
          inflight.delete(recordingId);
          return null;
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
