/**
 * Grab a single frame from a video URL at a given timestamp, returned as a
 * cached data URL. Used by the per-cue preview so users can position
 * subtitles against the *real* footage without spawning dozens of
 * concurrent <video> decoders.
 *
 * Cache is LRU-bounded and scoped by (videoSrc, roundedTime) so re-renders
 * are free and different projects don't collide.
 */

const MAX_ENTRIES = 80;
const cache = new Map<string, string>(); // insertion order = LRU

function keyFor(src: string, time: number): string {
  // Round to 0.25s — good enough visually and dramatically improves cache hits.
  return `${src}@${Math.round(time * 4) / 4}`;
}

function touch(key: string, value: string) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** In-flight requests so parallel callers don't spin up parallel decoders. */
const inflight = new Map<string, Promise<string>>();

export async function getFrameAt(videoSrc: string, timeSec: number, maxWidth = 640): Promise<string> {
  const key = keyFor(videoSrc, timeSec);
  const hit = cache.get(key);
  if (hit) {
    // Refresh LRU.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = grabFrame(videoSrc, timeSec, maxWidth)
    .then((dataUrl) => {
      touch(key, dataUrl);
      return dataUrl;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

function grabFrame(src: string, time: number, maxWidth: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;

    const cleanup = () => {
      video.removeAttribute("src");
      try { video.load(); } catch { /* ignore */ }
    };

    let seeked = false;
    const onError = () => {
      cleanup();
      reject(new Error("frame-snapshot: video failed to load"));
    };

    video.addEventListener("error", onError, { once: true });
    video.addEventListener("loadedmetadata", () => {
      const target = Math.max(0, Math.min(time, (video.duration || time) - 0.05));
      video.currentTime = target;
    }, { once: true });
    video.addEventListener("seeked", () => {
      if (seeked) return;
      seeked = true;
      try {
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 360;
        const scale = Math.min(1, maxWidth / vw);
        const w = Math.max(1, Math.round(vw * scale));
        const h = Math.max(1, Math.round(vh * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { cleanup(); reject(new Error("no 2d ctx")); return; }
        ctx.drawImage(video, 0, 0, w, h);
        const url = canvas.toDataURL("image/jpeg", 0.72);
        cleanup();
        resolve(url);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  });
}

export function clearFrameCache(): void {
  cache.clear();
  inflight.clear();
}
