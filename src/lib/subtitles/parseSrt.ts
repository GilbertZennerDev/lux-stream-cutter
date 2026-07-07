import type { SrtCue } from "./luxasrToSrt";

// Parse an SRT timestamp "HH:MM:SS,mmm" (comma or dot) into seconds.
function parseSrtTs(s: string): number {
  const m = s.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) throw new Error(`Bad SRT timestamp: ${s}`);
  const [, h, mm, ss, ms] = m;
  return Number(h) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
}

/** Parse an SRT string into SrtCue[]. Lenient on blank-line separators and CRLF. */
export function parseSrt(text: string): SrtCue[] {
  const cues: SrtCue[] = [];
  const norm = text.replace(/\r\n?/g, "\n").trim();
  if (!norm) return cues;
  const blocks = norm.split(/\n{2,}/);
  let idx = 1;
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    // Optional numeric index on first line.
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    const timing = lines[i];
    const arrow = timing.split("-->");
    if (arrow.length !== 2) continue;
    try {
      const start = parseSrtTs(arrow[0]);
      const end = parseSrtTs(arrow[1]);
      const text = lines.slice(i + 1).join("\n").trim();
      if (!text) continue;
      cues.push({ index: idx++, start, end, text });
    } catch {
      // skip malformed block
    }
  }
  return cues;
}
