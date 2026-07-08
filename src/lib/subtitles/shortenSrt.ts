import type { SrtCue } from "./luxasrToSrt";

// Split text into sentences by punctuation, keeping delimiters.
function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g);
  if (!parts) return [text.trim()].filter(Boolean);
  return parts.map((s) => s.trim()).filter(Boolean);
}

// Word-wrap a single line to at most `maxChars` per line at word boundaries.
function wrapLine(text: string, maxChars: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= maxChars) {
      current += " " + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

// Join sentences with a newline so each phrase renders on its own line,
// wrapping any sentence longer than maxChars at word boundaries.
function joinWithBreaks(sentences: string[], maxChars: number): string {
  return sentences
    .map((s) => wrapLine(s.trim(), maxChars))
    .filter(Boolean)
    .join("\n");
}

// Chunk into groups of up to `maxSentences` sentences and split cues
// proportionally by character length. Within each resulting cue, put
// each sentence on its own line.
export function shortenCues(
  cues: SrtCue[],
  opts: { maxSentences?: number; maxChars?: number } = {},
): SrtCue[] {
  const maxSentences = opts.maxSentences ?? 2;
  const maxChars = opts.maxChars ?? 90;
  const out: SrtCue[] = [];
  let idx = 1;

  for (const cue of cues) {
    const dur = Math.max(0.1, cue.end - cue.start);
    const sentences = splitSentences(cue.text);

    // Group sentences: up to maxSentences AND respecting maxChars total length.
    const groups: string[][] = [];
    let current: string[] = [];
    let currentLen = 0;
    for (const s of sentences) {
      const projected = currentLen + (current.length ? 1 : 0) + s.length;
      const wouldOverflow =
        (projected > maxChars && current.length > 0) ||
        current.length >= maxSentences;
      if (wouldOverflow) {
        groups.push(current);
        current = [s];
        currentLen = s.length;
      } else {
        current.push(s);
        currentLen = projected;
      }
    }
    if (current.length) groups.push(current);
    if (groups.length === 0) continue;

    const totalChars = groups.reduce(
      (n, g) => n + g.reduce((m, s) => m + s.length, 0),
      0,
    ) || 1;
    let cursor = cue.start;
    groups.forEach((g, i) => {
      const gChars = g.reduce((m, s) => m + s.length, 0);
      const share = i === groups.length - 1
        ? cue.end - cursor
        : (gChars / totalChars) * dur;
      const start = cursor;
      const end = i === groups.length - 1 ? cue.end : Math.min(cue.end, cursor + share);
      out.push({ index: idx++, start, end, text: joinWithBreaks(g, maxChars) });
      cursor = end;
    });
  }
  return out;
}
