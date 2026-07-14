import type { CSSProperties } from "react";
import type { SubtitleLook } from "@/lib/ffmpeg/operations";

/**
 * Translate a `SubtitleLook` + preview-scaled outline into inline styles that
 * approximate the burned-in ASS output as closely as HTML/CSS allows.
 * Used by every subtitle preview so WYSIWYG holds across the app.
 */
export function renderSubtitleStyle(
  look: SubtitleLook | undefined,
  previewOutline: number,
  previewShadow: number,
): { textStyle: CSSProperties; boxStyle: CSSProperties | null } {
  const primary = look?.primaryColor ?? "#FFFFFF";
  const outlineCol = look?.outlineColor ?? "#000000";
  const shadowCol = look?.shadowColor ?? "#000000";
  const isBox = look?.borderStyle === "box";
  const bold = look?.bold !== false;
  const italic = !!look?.italic;

  const parts: string[] = [];
  // 8-way outline stroke
  if (previewOutline > 0 && !isBox) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const dx = Math.cos(a) * previewOutline;
      const dy = Math.sin(a) * previewOutline;
      parts.push(`${dx.toFixed(2)}px ${dy.toFixed(2)}px 0 ${outlineCol}`);
    }
  }
  if (previewShadow > 0) {
    parts.push(`${previewShadow.toFixed(2)}px ${previewShadow.toFixed(2)}px ${(previewShadow * 1.5).toFixed(2)}px ${shadowCol}`);
  }
  const textShadow = parts.length ? parts.join(", ") : "none";

  const textStyle: CSSProperties = {
    color: primary,
    textShadow,
    fontWeight: bold ? 600 : 400,
    fontStyle: italic ? "italic" : "normal",
  };

  if (isBox) {
    return {
      textStyle,
      boxStyle: {
        backgroundColor: shadowCol,
        padding: `${Math.max(2, previewOutline * 1.2)}px ${Math.max(6, previewOutline * 2)}px`,
        borderRadius: "2px",
        display: "inline-block",
      },
    };
  }
  return { textStyle, boxStyle: null };
}
