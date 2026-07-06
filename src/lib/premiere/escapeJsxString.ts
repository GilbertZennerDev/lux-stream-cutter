/**
 * Escape a string for safe embedding inside a single-quoted ExtendScript string.
 * ExtendScript is ES3-ish; keep it conservative: backslashes, quotes, newlines, CR, TAB.
 */
export function escapeJsxString(input: string): string {
  return String(input)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

/** Quoted single-quoted JSX string literal, ready to drop into generated code. */
export function q(input: string): string {
  return `'${escapeJsxString(input)}'`;
}
