import { fetchFile } from "@ffmpeg/util";
import { getFFmpeg, onProgress, type ProgressCb } from "./client";
import { formatSeconds } from "../subtitles/parseTime";

export interface PerfOptions {
  /** Optimise for weak hardware: ultrafast preset, higher CRF, downscale, single thread. */
  lowPerf?: boolean;
  /** Max video height when re-encoding (only used if lowPerf or explicitly set). */
  maxHeight?: number;
  /**
   * Shift the audio track by this many seconds relative to the video.
   * Positive = audio plays later (delayed by silence padding).
   * Negative = audio plays earlier (trims that many seconds off the start).
   * When non-zero, audio is always re-encoded (no fast copy).
   */
  audioOffsetSec?: number;
}

function audioOffsetFilter(perf: PerfOptions): string | null {
  const off = perf.audioOffsetSec ?? 0;
  if (!off || Math.abs(off) < 0.001) return null;
  if (off > 0) {
    const ms = Math.round(off * 1000);
    return `adelay=${ms}|${ms}`;
  }
  return `atrim=start=${(-off).toFixed(3)},asetpts=PTS-STARTPTS`;
}


function encodeArgs(perf: PerfOptions): string[] {
  const preset = perf.lowPerf ? "ultrafast" : "veryfast";
  const crf = perf.lowPerf ? "28" : "22";
  return [
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", crf,
    "-tune", "fastdecode",
    "-pix_fmt", "yuv420p",
  ];
}

function threadArgs(perf: PerfOptions): string[] {
  // ffmpeg.wasm runs in a worker; keep threads low on weak machines to avoid OOM.
  return perf.lowPerf ? ["-threads", "1"] : ["-threads", "2"];
}

function tempToken() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

async function readOutputFile(
  ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>,
  outputName: string,
  context: string,
): Promise<Uint8Array> {
  try {
    return (await ffmpeg.readFile(outputName)) as Uint8Array;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${context} did not create an output file${detail ? `: ${detail}` : ""}`);
  }
}

function reencodeCutArgs(
  inputName: string,
  outputName: string,
  startSec: number,
  endSec: number,
  perf: PerfOptions,
): string[] {
  const duration = (endSec - startSec).toFixed(3);
  const args = [
    "-ss", formatSeconds(startSec),
    "-i", inputName,
    "-t", duration,
    "-map", "0:v:0",
    "-map", "0:a?",
    ...encodeArgs(perf),
    "-c:a", "aac", "-b:a", perf.lowPerf ? "96k" : "128k",
    ...threadArgs(perf),
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    "-y", outputName,
  ];
  const af = audioOffsetFilter(perf);
  if (af) args.splice(args.indexOf("-c:a"), 0, "-af", af);
  const sf = scaleFilter(perf);
  if (sf) args.splice(args.indexOf("-c:v"), 0, "-vf", sf);
  return args;
}


function scaleFilter(perf: PerfOptions): string | null {
  const h = perf.maxHeight ?? (perf.lowPerf ? 480 : 0);
  if (!h) return null;
  // Only downscale if source is larger; keep even dims for yuv420p.
  return `scale='min(iw,trunc(oh*a/2)*2)':'min(${h},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
}

/** Fast remux of an MPEG-TS blob into an MP4 container (no re-encode). */
export async function remuxTsToMp4(
  file: File | Blob,
  onP?: ProgressCb,
): Promise<Uint8Array> {
  const ffmpeg = await getFFmpeg();
  const off = onP ? onProgress(ffmpeg, onP) : () => {};
  const token = tempToken();
  const inputName = `remux_${token}.ts`;
  const outputName = `remux_${token}.mp4`;
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  const tryExec = async (args: string[]) => {
    await ffmpeg.exec(args);
    return readOutputFile(ffmpeg, outputName, "TS remux");
  };
  try {
    // First attempt: copy both streams, apply AAC ADTS→ASC when audio is AAC.
    try {
      return await tryExec([
        "-fflags", "+genpts",
        "-i", inputName,
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        "-movflags", "+faststart",
        "-y", outputName,
      ]);
    } catch {
      // Second attempt: copy both streams without the ADTS filter (audio may
      // already be in a container-friendly form, or the container has no audio).
      try {
        return await tryExec([
          "-fflags", "+genpts",
          "-i", inputName,
          "-c", "copy",
          "-movflags", "+faststart",
          "-y", outputName,
        ]);
      } catch {
        // Last resort: video-only remux (some HLS variants ship no audio at all).
        return await tryExec([
          "-fflags", "+genpts",
          "-i", inputName,
          "-map", "0:v:0",
          "-c", "copy",
          "-movflags", "+faststart",
          "-y", outputName,
        ]);
      }
    }
  } finally {
    off();
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}


export async function cutVideo(
  file: File | Blob,
  startSec: number,
  endSec: number,
  onP?: ProgressCb,
  perf: PerfOptions = {},
): Promise<Uint8Array> {
  if (endSec <= startSec) throw new Error("End must be greater than start");
  const ffmpeg = await getFFmpeg();
  const off = onP ? onProgress(ffmpeg, onP) : () => {};
  const token = tempToken();
  const inputName = `cut_${token}.bin`;
  const outputName = `cut_${token}.mp4`;
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  const duration = (endSec - startSec).toFixed(3);
  const mustReencode = !!(perf.lowPerf || perf.maxHeight || (perf.audioOffsetSec && Math.abs(perf.audioOffsetSec) >= 0.001));
  try {
    if (mustReencode) throw new Error("reencode");
    // Fast copy: no CPU cost, ideal for weak hardware.
    await ffmpeg.exec([
      "-ss", formatSeconds(startSec),
      "-i", inputName,
      "-t", duration,
      "-c", "copy",
      "-movflags", "+faststart",
      "-y", outputName,
    ]);
    return await readOutputFile(ffmpeg, outputName, "Fast cut");
  } catch {
    // Re-encode fallback (keyframe-accurate)
    try { await ffmpeg.deleteFile(outputName); } catch {}
    const args = reencodeCutArgs(inputName, outputName, startSec, endSec, perf);
    await ffmpeg.exec(args);
    return await readOutputFile(ffmpeg, outputName, "Re-encoded cut");
  } finally {
    off();
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}

export async function cutAndConcat(
  file: File | Blob,
  segments: Array<{ start: number; end: number }>,
  onP?: ProgressCb,
  perf: PerfOptions = {},
): Promise<Uint8Array> {
  if (segments.length === 0) throw new Error("No segments to cut");
  for (const s of segments) {
    if (s.end <= s.start) throw new Error("End must be greater than start in every segment");
  }
  if (segments.length === 1) {
    return cutVideo(file, segments[0].start, segments[0].end, onP, perf);
  }
  const ffmpeg = await getFFmpeg();
  const off = onP ? onProgress(ffmpeg, onP) : () => {};
  const token = tempToken();
  const inputName = `concat_input_${token}.bin`;
  const listName = `concat_${token}.txt`;
  const outputName = `concat_${token}.mp4`;
  const segmentNames = segments.map((_, i) => `concat_part_${token}_${i}.mp4`);
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  try {
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      await ffmpeg.exec(reencodeCutArgs(inputName, segmentNames[i], s.start, s.end, perf));
      await readOutputFile(ffmpeg, segmentNames[i], `Segment ${i + 1}`);
    }

    await ffmpeg.writeFile(
      listName,
      new TextEncoder().encode(segmentNames.map((name) => `file '${name}'`).join("\n")),
    );

    try {
      await ffmpeg.exec([
        "-f", "concat",
        "-safe", "0",
        "-i", listName,
        "-c", "copy",
        "-movflags", "+faststart",
        "-y", outputName,
      ]);
      return await readOutputFile(ffmpeg, outputName, "Concatenation");
    } catch {
      try { await ffmpeg.deleteFile(outputName); } catch {}
      await ffmpeg.exec([
        "-f", "concat",
        "-safe", "0",
        "-i", listName,
        "-map", "0:v:0",
        "-map", "0:a?",
        ...encodeArgs(perf),
        "-c:a", "aac", "-b:a", perf.lowPerf ? "96k" : "128k",
        ...threadArgs(perf),
        "-movflags", "+faststart",
        "-y", outputName,
      ]);
      return await readOutputFile(ffmpeg, outputName, "Re-encoded concatenation");
    }
  } finally {
    off();
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(listName); } catch {}
    for (const name of segmentNames) {
      try { await ffmpeg.deleteFile(name); } catch {}
    }
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}




export async function extractAudioMp3(
  file: File | Blob,
  onP?: ProgressCb,
  perf: PerfOptions = {},
): Promise<Uint8Array> {
  const ffmpeg = await getFFmpeg();
  const off = onP ? onProgress(ffmpeg, onP) : () => {};
  const token = tempToken();
  const inputName = `audio_input_${token}.mp4`;
  const outputName = `audio_${token}.mp3`;
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  try {
    try {
      await ffmpeg.exec([
        "-i", inputName,
        "-map", "0:a:0",
        "-vn",
        "-ar", "16000", "-ac", "1",
        // On weak hardware a slightly lower quality MP3 still transcribes fine
        // and is 20-30% faster to encode.
        "-c:a", "libmp3lame", "-q:a", perf.lowPerf ? "7" : "4",
        ...threadArgs(perf),
        "-y", outputName,
      ]);
      return await readOutputFile(ffmpeg, outputName, "Audio extraction");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        detail.includes("Stream map") ||
          detail.includes("matches no streams") ||
          detail.includes("did not create an output file") ||
          /ErrnoError:\s*FS error|FS error/i.test(detail)
          ? "No usable audio track found in this clip"
          : `Audio extraction failed${detail ? `: ${detail}` : ""}`,
      );
    }
  } finally {
    off();
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}

const FONT_URL =
  "https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf";
const FONT_FAMILY = "Noto Sans";

/** Built-in fonts we bundle into the ffmpeg.wasm virtual FS on demand. */
const BUILTIN_FONTS: Record<string, { url: string; format: string }> = {
  Lato: {
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/lato/Lato-Regular.ttf",
    format: "ttf",
  },
};

export const BUILTIN_FONT_FAMILIES = Object.keys(BUILTIN_FONTS);

export interface CustomFont {
  /** ASS Fontname — must match the font's actual family name. */
  family: string;
  /** Path inside the private `fonts` Supabase storage bucket. */
  storagePath: string;
  /** File extension (ttf | otf | woff | woff2). */
  format: string;
  /** Optional pre-fetched bytes; if omitted, downloaded from Supabase storage. */
  bytes?: Uint8Array;
}

// Track font install per ffmpeg instance. A cancel/reload creates a new
// FFmpeg with a fresh virtual filesystem, so a module-level set would
// falsely report the font as loaded and libass would silently render
// nothing — subtitles disappear from the burned output.
const baseFontLoadedFor = new WeakSet<object>();
const customFontsLoadedFor = new WeakMap<object, Set<string>>();

function sanitizeFontFile(name: string) {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/**
 * Extract the actual font family name from a TTF/OTF SFNT `name` table.
 * libass matches ASS `Fontname` against this internal name, NOT the file
 * name or whatever we stored in the DB. Returns null for unsupported
 * containers (woff/woff2) or malformed files — caller should fall back.
 */
function readFontFamilyName(bytes: Uint8Array): string | null {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const scaler = dv.getUint32(0);
    // Accept TrueType (0x00010000, 'true', 'ttcf') and OpenType ('OTTO').
    const isSfnt =
      scaler === 0x00010000 || scaler === 0x74727565 /* 'true' */ ||
      scaler === 0x4f54544f /* 'OTTO' */;
    if (!isSfnt) return null;
    const numTables = dv.getUint16(4);
    let nameOff = 0, nameLen = 0;
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
      if (tag === "name") { nameOff = dv.getUint32(o + 8); nameLen = dv.getUint32(o + 12); break; }
    }
    if (!nameOff || !nameLen) return null;
    const count = dv.getUint16(nameOff + 2);
    const strOff = nameOff + dv.getUint16(nameOff + 4);
    let family: string | null = null;
    let preferred: string | null = null;
    for (let i = 0; i < count; i++) {
      const rec = nameOff + 6 + i * 12;
      const platformId = dv.getUint16(rec);
      const nameID = dv.getUint16(rec + 6);
      const len = dv.getUint16(rec + 8);
      const off = dv.getUint16(rec + 10);
      if (nameID !== 1 && nameID !== 16) continue;
      const slice = bytes.subarray(strOff + off, strOff + off + len);
      let str: string;
      if (platformId === 3 || platformId === 0) {
        // UTF-16BE
        let s = "";
        for (let j = 0; j + 1 < slice.length; j += 2) {
          s += String.fromCharCode((slice[j] << 8) | slice[j + 1]);
        }
        str = s;
      } else {
        str = String.fromCharCode(...slice);
      }
      if (nameID === 16 && !preferred) preferred = str;
      else if (nameID === 1 && !family) family = str;
    }
    return preferred || family;
  } catch {
    return null;
  }
}

async function ensureFont(
  ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>,
  custom?: CustomFont,
): Promise<{ fontFile?: string; realFamily?: string }> {
  if (!baseFontLoadedFor.has(ffmpeg)) {
    try {
      await ffmpeg.createDir("/fonts");
    } catch {
      // already exists
    }
    const bytes = await fetchFile(FONT_URL);
    await ffmpeg.writeFile("/fonts/NotoSans-Regular.ttf", bytes);
    baseFontLoadedFor.add(ffmpeg);
  }
  if (!custom) return {};
  const filename = `/fonts/${sanitizeFontFile(custom.family)}.${custom.format}`;
  const key = `${custom.family}::${custom.storagePath}`;
  let loaded = customFontsLoadedFor.get(ffmpeg);
  if (!loaded) {
    loaded = new Set();
    customFontsLoadedFor.set(ffmpeg, loaded);
  }
  let bytes = custom.bytes;
  if (!loaded.has(key)) {
    if (!bytes) {
      const { supabase } = await import("@/integrations/supabase/client");
      console.log(`[ensureFont] downloading "${custom.family}" from storage: ${custom.storagePath}`);
      const { data, error } = await supabase.storage.from("fonts").download(custom.storagePath);
      if (error || !data) throw new Error(`Failed to download font: ${error?.message ?? "unknown"}`);
      bytes = new Uint8Array(await data.arrayBuffer());
    }
    await ffmpeg.writeFile(filename, bytes);
    loaded.add(key);
  }
  // Always parse bytes (fetch from FS if we skipped download) to learn real family.
  if (!bytes) {
    try { bytes = (await ffmpeg.readFile(filename)) as Uint8Array; } catch {}
  }
  const realFamily = bytes ? readFontFamilyName(bytes) ?? undefined : undefined;
  console.log(`[ensureFont] "${custom.family}" -> internal family: "${realFamily ?? "(unknown)"}"`);
  return { fontFile: filename, realFamily };
}




export interface SubtitleStyle {
  /** Font size in pixels (relative to source video height in ASS PlayRes) */
  fontSize: number;
  /** Outline (black contour) thickness in pixels. 0 disables. */
  outline: number;
  /** Horizontal position of the subtitle's centre, 0..100 (% of video width). */
  xPct: number;
  /** Vertical position of the subtitle's centre, 0..100 (% of video height). */
  yPct: number;
  /** Video width in pixels (used as ASS PlayResX). */
  videoWidth: number;
  /** Video height in pixels (used as ASS PlayResY). */
  videoHeight: number;
}

function assTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

export interface AssCue { start: number; end: number; text: string; xPct?: number; yPct?: number }

// Cache one measuring context per font-size so we don't recreate it per cue.
let wrapCanvas: HTMLCanvasElement | null = null;
let wrapCtx: CanvasRenderingContext2D | null = null;
function getWrapCtx(fontSize: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!wrapCanvas) {
    wrapCanvas = document.createElement("canvas");
    wrapCtx = wrapCanvas.getContext("2d");
  }
  if (!wrapCtx) return null;
  // Match burn font (Noto Sans, Bold=1) and preview (`font-semibold`).
  wrapCtx.font = `bold ${fontSize}px "Noto Sans", system-ui, sans-serif`;
  return wrapCtx;
}

/**
 * Greedy word-wrap that mirrors the preview's `max-width: 92%` behaviour so
 * the burned output breaks at the same points. Preserves any hard \n the
 * user typed. Falls back to a char-count heuristic outside the browser
 * (worker/SSR) so results stay deterministic.
 */
function wrapTextForAss(text: string, fontSize: number, maxWidthPx: number): string {
  const ctx = getWrapCtx(fontSize);
  const fallbackCharsPerLine = Math.max(6, Math.floor(maxWidthPx / (fontSize * 0.55)));

  const wrapLine = (line: string): string => {
    const trimmed = line.trim();
    if (!trimmed) return "";
    const words = trimmed.split(/\s+/);
    const out: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      const width = ctx ? ctx.measureText(candidate).width : candidate.length * fontSize * 0.55;
      const fits = ctx ? width <= maxWidthPx : candidate.length <= fallbackCharsPerLine;
      if (fits || !current) {
        current = candidate;
      } else {
        out.push(current);
        current = word;
      }
    }
    if (current) out.push(current);
    return out.join("\n");
  };

  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(wrapLine)
    .join("\n");
}

export function cuesToAss(cues: AssCue[], style: SubtitleStyle, fontFamily?: string): string {
  const w = Math.max(1, Math.round(style.videoWidth));
  const h = Math.max(1, Math.round(style.videoHeight));
  const outline = Math.max(0, style.outline);
  const defaultX = Math.round((style.xPct / 100) * w);
  const defaultY = Math.round((style.yPct / 100) * h);
  const family = fontFamily && fontFamily.trim() ? fontFamily : FONT_FAMILY;

  // Alignment=5 => middle-center anchor, so \pos(x,y) places the centre of the text at (x,y).
  const styleLine =
    `Style: Default,${family},${style.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,` +
    `1,0,0,0,100,100,0,0,1,${outline},0,5,0,0,0,1`;


  // Match the preview: captions in <CuePreview>/<LiveSubtitleOverlay> wrap
  // inside a box that's ~92% of the video width. libass with WrapStyle=2
  // never auto-wraps, so we pre-wrap here and let it honour our \N breaks.
  const maxWidthPx = Math.round(w * 0.92);

  const events = cues
    .filter((c) => c.end > c.start && c.text.trim().length > 0)
    .map((c) => {
      const px = typeof c.xPct === "number" ? Math.round((c.xPct / 100) * w) : defaultX;
      const py = typeof c.yPct === "number" ? Math.round((c.yPct / 100) * h) : defaultY;
      const wrapped = wrapTextForAss(c.text, style.fontSize, maxWidthPx);
      return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,{\\pos(${px},${py})}${escapeAssText(wrapped)}`;
    })
    .join("\n");

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styleLine,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    events,
    "",
  ].join("\n");
}

export async function burnSubtitles(
  video: File | Blob,
  assText: string,
  onP?: ProgressCb,
  perf: PerfOptions = {},
  customFont?: CustomFont,
  builtinFontName?: string,
): Promise<Uint8Array> {
  const ffmpeg = await getFFmpeg();
  const off = onP ? onProgress(ffmpeg, onP) : () => {};
  const token = tempToken();
  const inputName = `burn_input_${token}.mp4`;
  const subsName = `subs_${token}.ass`;
  const outputName = `burned_${token}.mp4`;



  await ffmpeg.writeFile(inputName, await fetchFile(video));
  const { fontFile, realFamily: customRealFamily } = await ensureFont(ffmpeg, customFont);

  // Bundle a built-in font (e.g. Lato) into /fonts. ffmpeg.wasm has no system
  // fonts, so anything other than Noto Sans must be shipped in.
  let builtinRealFamily: string | undefined;
  if (!fontFile && builtinFontName && BUILTIN_FONTS[builtinFontName]) {
    const spec = BUILTIN_FONTS[builtinFontName];
    const filename = `/fonts/${sanitizeFontFile(builtinFontName)}.${spec.format}`;
    let loaded = customFontsLoadedFor.get(ffmpeg);
    if (!loaded) { loaded = new Set(); customFontsLoadedFor.set(ffmpeg, loaded); }
    const key = `builtin::${builtinFontName}`;
    let bytes: Uint8Array | undefined;
    if (!loaded.has(key)) {
      const t0 = performance.now();
      bytes = await fetchFile(spec.url);
      await ffmpeg.writeFile(filename, bytes);
      console.log(`[burnSubtitles] bundled built-in "${builtinFontName}" — ${bytes.byteLength} bytes in ${Math.round(performance.now() - t0)}ms`);
      loaded.add(key);
    } else {
      try { bytes = (await ffmpeg.readFile(filename)) as Uint8Array; } catch {}
    }
    builtinRealFamily = bytes ? readFontFamilyName(bytes) ?? undefined : undefined;
    console.log(`[burnSubtitles] built-in "${builtinFontName}" -> internal family: "${builtinRealFamily ?? "(unknown)"}"`);
  }

  // libass matches ASS `Fontname` against the font's INTERNAL family name
  // (from its SFNT `name` table), not the file name. If our DB label or the
  // caller's builtin name doesn't match, patch the ASS Style line so libass
  // resolves the font correctly via fontsdir. `FontFile=` is NOT a valid ASS
  // style attribute — libass silently ignores it, which is why prior attempts
  // rendered the fallback (Noto Sans) or nothing at all.
  const targetFamily = customRealFamily ?? builtinRealFamily ?? undefined;
  let patchedAss = assText;
  if (targetFamily) {
    patchedAss = patchedAss.replace(
      /^(Style:\s*Default,)[^,]*,/m,
      `$1${targetFamily},`,
    );
  }
  await ffmpeg.writeFile(subsName, new TextEncoder().encode(patchedAss));

  const sf = scaleFilter(perf);
  const subFilter = `subtitles=${subsName}:fontsdir=/fonts`;
  const vf = sf ? `${sf},${subFilter}` : subFilter;
  console.log(`[burnSubtitles] vf =`, vf, `targetFamily =`, targetFamily, `customFont =`, customFont?.family, `builtinFont =`, builtinFontName);
  try {
    // NOTE: Do NOT combine `-map 0:v:0` with `-vf` here. When the video
    // stream is explicitly mapped, ffmpeg.wasm's simple-filter (`-vf`) path
    // can be bypassed and the video passes through un-filtered — the output
    // renders without any burned subtitles. Rely on default stream
    // selection (best video + best audio) so `-vf` is applied correctly.
    await ffmpeg.exec([
      "-i", inputName,
      "-vf", vf,
      ...encodeArgs(perf),
      "-c:a", "aac", "-b:a", perf.lowPerf ? "96k" : "128k",
      ...threadArgs(perf),
      "-movflags", "+faststart",
      "-y", outputName,
    ]);



    return await readOutputFile(ffmpeg, outputName, "Subtitle burn-in");
  } finally {
    off();
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(subsName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}

/** Read intrinsic width/height from a video File/Blob using a hidden element. */
export async function getVideoDimensions(src: File | Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(src);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const cleanup = () => URL.revokeObjectURL(url);
    v.onloadedmetadata = () => {
      const width = v.videoWidth || 1280;
      const height = v.videoHeight || 720;
      cleanup();
      resolve({ width, height });
    };
    v.onerror = () => {
      cleanup();
      reject(new Error("Could not read video metadata"));
    };
    v.src = url;
  });
}
