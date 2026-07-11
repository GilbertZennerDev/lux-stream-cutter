/**
 * Fetches the shared font list, injects one `@font-face` rule per ready font
 * into a singleton <style> tag on the document, and exposes a small helper
 * shape the Cutter uses to pick a font.
 *
 * The same family name lives in three places (CSS `font-family`, ASS
 * `Fontname`, and the ffmpeg /fonts filename). We keep them in sync by
 * always using the value stored in `fonts.family`.
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { listFonts, type FontRow } from "@/lib/fonts.functions";

const STYLE_ID = "cutter-font-faces";

function cssFormat(format: string): string {
  switch (format) {
    case "ttf": return "truetype";
    case "otf": return "opentype";
    case "woff": return "woff";
    case "woff2": return "woff2";
    default: return format;
  }
}

function injectFontFaces(fonts: FontRow[]): void {
  if (typeof document === "undefined") return;
  let tag = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = STYLE_ID;
    document.head.appendChild(tag);
  }
  const rules = fonts
    .filter((f) => f.status === "ready" && f.url)
    .map((f) => {
      // CSS.escape isn't universal in older browsers, so we just double-quote
      // and drop stray `"` from the family name.
      const family = f.family.replace(/"/g, "");
      return `@font-face { font-family: "${family}"; src: url("${f.url}") format("${cssFormat(f.format)}"); font-display: swap; }`;
    })
    .join("\n");
  if (tag.textContent !== rules) tag.textContent = rules;
}

export function useFonts() {
  const list = useServerFn(listFonts);
  const q = useQuery({
    queryKey: ["fonts"],
    queryFn: () => list(),
    // Signed URLs live 24h; refetch every 6h so they stay warm.
    staleTime: 1000 * 60 * 60 * 6,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (q.data) injectFontFaces(q.data);
  }, [q.data]);

  const fonts = q.data ?? [];
  const defaultFont = fonts.find((f) => f.isDefault && f.status === "ready") ?? null;

  return {
    fonts,
    defaultFont,
    isLoading: q.isLoading,
    refetch: q.refetch,
  };
}
