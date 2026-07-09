/**
 * Hardware capability probe. Runs once, cached in module scope.
 * Classifies the current browser/machine into Low / Medium / High
 * so heavy operations (ffmpeg.wasm, MediaPipe, WebCodecs) can pick
 * the fastest safe path.
 */

export type PerfTier = "low" | "medium" | "high";

export interface PerfCapabilities {
  cores: number;
  memoryGb: number | null;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  webgl2: boolean;
  webgpu: boolean;
  webcodecsDecode: boolean;
  webcodecsEncode: boolean;
  gpuVendor: string | null;
  gpuArchitecture: string | null;
  isMobile: boolean;
}

export interface PerfReport {
  tier: PerfTier;
  caps: PerfCapabilities;
  reasons: string[];
}

const H264_BASELINE = "avc1.42E01F"; // Baseline 3.1 – broadly supported

let cached: Promise<PerfReport> | null = null;

async function probeWebCodecs(): Promise<{ decode: boolean; encode: boolean }> {
  if (typeof window === "undefined") return { decode: false, encode: false };
  const w = window as unknown as {
    VideoDecoder?: {
      isConfigSupported: (c: { codec: string }) => Promise<{ supported?: boolean }>;
    };
    VideoEncoder?: {
      isConfigSupported: (c: {
        codec: string;
        width: number;
        height: number;
        bitrate: number;
      }) => Promise<{ supported?: boolean }>;
    };
  };
  let decode = false;
  let encode = false;
  try {
    if (w.VideoDecoder?.isConfigSupported) {
      const r = await w.VideoDecoder.isConfigSupported({ codec: H264_BASELINE });
      decode = !!r.supported;
    }
  } catch {
    decode = false;
  }
  try {
    if (w.VideoEncoder?.isConfigSupported) {
      const r = await w.VideoEncoder.isConfigSupported({
        codec: H264_BASELINE,
        width: 1280,
        height: 720,
        bitrate: 4_000_000,
      });
      encode = !!r.supported;
    }
  } catch {
    encode = false;
  }
  return { decode, encode };
}

async function probeWebGPU(): Promise<{
  supported: boolean;
  vendor: string | null;
  architecture: string | null;
}> {
  if (typeof navigator === "undefined") return { supported: false, vendor: null, architecture: null };
  const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
  if (!gpu) return { supported: false, vendor: null, architecture: null };
  try {
    const adapter = (await gpu.requestAdapter()) as
      | (null | { info?: { vendor?: string; architecture?: string } })
      | null;
    if (!adapter) return { supported: false, vendor: null, architecture: null };
    return {
      supported: true,
      vendor: adapter.info?.vendor ?? null,
      architecture: adapter.info?.architecture ?? null,
    };
  } catch {
    return { supported: false, vendor: null, architecture: null };
  }
}

function probeWebGL2(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    return !!gl;
  } catch {
    return false;
  }
}

function detectMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as unknown as { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === "boolean") return uaData.mobile;
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function detectPerf(): Promise<PerfReport> {
  if (cached) return cached;
  cached = (async () => {
    const cores =
      typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
    const memoryGb =
      (typeof navigator !== "undefined"
        ? (navigator as unknown as { deviceMemory?: number }).deviceMemory
        : undefined) ?? null;
    const coi = typeof window !== "undefined" && !!(window as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    const sab = typeof SharedArrayBuffer !== "undefined";
    const webgl2 = probeWebGL2();
    const [{ decode, encode }, gpu] = await Promise.all([
      probeWebCodecs(),
      probeWebGPU(),
    ]);
    const isMobile = detectMobile();

    const caps: PerfCapabilities = {
      cores,
      memoryGb,
      crossOriginIsolated: coi,
      sharedArrayBuffer: sab,
      webgl2,
      webgpu: gpu.supported,
      webcodecsDecode: decode,
      webcodecsEncode: encode,
      gpuVendor: gpu.vendor,
      gpuArchitecture: gpu.architecture,
      isMobile,
    };

    const reasons: string[] = [];
    let tier: PerfTier;
    if (isMobile) {
      tier = "low";
      reasons.push("mobile device");
    } else if (decode && encode && (gpu.supported || webgl2) && cores >= 8) {
      tier = "high";
      reasons.push(`WebCodecs H.264 + ${gpu.supported ? "WebGPU" : "WebGL2"} + ${cores} cores`);
    } else if (webgl2 && cores >= 4) {
      tier = "medium";
      reasons.push(`WebGL2 + ${cores} cores`);
    } else {
      tier = "low";
      reasons.push(`only ${cores} cores${webgl2 ? "" : ", no WebGL2"}`);
    }

    // eslint-disable-next-line no-console
    console.info("[perf]", { tier, caps, reasons });
    return { tier, caps, reasons };
  })();
  return cached;
}

export interface TierProfile {
  /** ffmpeg.wasm: ultrafast preset + higher CRF. */
  lowPerf: boolean;
  /** ffmpeg.wasm: force max output height (0 = source). */
  maxHeight: 0 | 480 | 720 | 1080;
  /** ffmpeg.wasm thread count (respect crossOriginIsolated). */
  threads: number;
  /** MediaPipe delegate for lip-sync. */
  lipsyncDelegate: "CPU" | "GPU";
  /** Sampling fps for lip-sync. */
  lipsyncFps: number;
  /** Max lag searched by lip-sync (seconds). */
  lipsyncMaxLag: number;
  /** Try the WebCodecs audio extraction path first. */
  webcodecsAudio: boolean;
}

export function profileFor(tier: PerfTier, caps: PerfCapabilities): TierProfile {
  const threadsMax = caps.crossOriginIsolated && caps.sharedArrayBuffer ? Math.min(caps.cores, 8) : 1;
  if (tier === "high") {
    return {
      lowPerf: false,
      maxHeight: 0,
      threads: Math.max(2, Math.min(threadsMax, 4)),
      lipsyncDelegate: caps.webgpu || caps.webgl2 ? "GPU" : "CPU",
      lipsyncFps: 30,
      lipsyncMaxLag: 1.0,
      webcodecsAudio: caps.webcodecsDecode,
    };
  }
  if (tier === "medium") {
    return {
      lowPerf: false,
      maxHeight: 0,
      threads: Math.max(1, Math.min(threadsMax, 2)),
      // WebGL2 only proves the browser can create a graphics context; it does
      // not guarantee that MediaPipe's GPU delegate is stable or faster. Keep
      // the Medium tier conservative so auto-sync does not hang on common
      // integrated GPUs. High tier still opts into GPU below.
      lipsyncDelegate: "CPU",
      lipsyncFps: 20,
      lipsyncMaxLag: 1.0,
      webcodecsAudio: caps.webcodecsDecode,
    };
  }
  return {
    lowPerf: true,
    maxHeight: 480,
    threads: 1,
    lipsyncDelegate: "CPU",
    lipsyncFps: 15,
    lipsyncMaxLag: 0.8,
    webcodecsAudio: false,
  };
}
