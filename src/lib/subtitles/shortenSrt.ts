import type { SrtCue } from "./luxasrToSrt";

/**
 * "Shorten" cues by inserting a newline after each sentence-ending
 * punctuation mark (. ? ! …). Does not split cues or change timings.
 * The options are kept for backwards compatibility but are ignored.
 */
export function shortenCues(
  cues: SrtCue[],
  _opts: { maxSentences?: number; maxChars?: number } = {},
): SrtCue[] {
  return cues.map((c, i) => ({
    index: i + 1,
    start: c.start,
    end: c.end,
    text: breakAfterSentences(c.text),
  }));
}

function breakAfterSentences(text: string): string {
  // Insert a newline after . ? ! or … (optionally followed by closing
  // quotes/brackets) when followed by whitespace + more text.
  return text
    .replace(/([.!?…]+["')\]]*)\s+(?=\S)/g, "$1\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
