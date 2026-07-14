import type { SubtitleLook } from "@/lib/ffmpeg/operations";

export interface SubtitleLookPreset {
  id: string;
  label: string;
  hint: string;
  look: SubtitleLook;
  outline?: number;
  bold?: boolean;
}

/**
 * One-click looks that cover ~90% of what users want. Applying a preset
 * writes into both `look` (colours/effects) and, when specified, the
 * `outline` slider so the visual result matches the preview immediately.
 */
export const SUBTITLE_LOOK_PRESETS: SubtitleLookPreset[] = [
  {
    id: "classic",
    label: "Classic",
    hint: "White text, black outline",
    look: {
      primaryColor: "#FFFFFF",
      outlineColor: "#000000",
      shadow: 0,
      shadowColor: "#000000",
      borderStyle: "outline",
      bold: true,
      italic: false,
      fadeMs: 0,
      popIn: false,
    },
    outline: 2,
  },
  {
    id: "news",
    label: "News",
    hint: "White text on solid black box",
    look: {
      primaryColor: "#FFFFFF",
      outlineColor: "#000000",
      shadow: 0,
      shadowColor: "#000000",
      borderStyle: "box",
      bold: true,
      italic: false,
      fadeMs: 120,
      popIn: false,
    },
    outline: 6,
  },
  {
    id: "youtube",
    label: "YouTube Pop",
    hint: "Bold yellow, black outline, pop-in",
    look: {
      primaryColor: "#FFE500",
      outlineColor: "#000000",
      shadow: 2,
      shadowColor: "#000000",
      borderStyle: "outline",
      bold: true,
      italic: false,
      fadeMs: 80,
      popIn: true,
    },
    outline: 3,
  },
  {
    id: "cinema",
    label: "Cinema",
    hint: "Cream text, soft shadow, fade",
    look: {
      primaryColor: "#F5EBD6",
      outlineColor: "#000000",
      shadow: 3,
      shadowColor: "#000000",
      borderStyle: "outline",
      bold: false,
      italic: false,
      fadeMs: 200,
      popIn: false,
    },
    outline: 1,
  },
];

export const DEFAULT_SUBTITLE_LOOK: SubtitleLook = SUBTITLE_LOOK_PRESETS[0].look;
