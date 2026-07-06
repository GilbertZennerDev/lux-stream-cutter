import { z } from "zod";

export const premiereOptionsSchema = z.object({
  sequenceName: z.string().trim().min(1).max(80).default("Generated Sequence"),
  binName: z.string().trim().min(1).max(80).default("Auto Import"),
  frameRate: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default(25),
  resolution: z.enum(["1920x1080", "3840x2160", "auto"]).default("1920x1080"),
  clipDurationSec: z.number().min(0.1).max(60).default(3),
  transition: z.enum(["none", "cross_dissolve", "dip_to_black"]).default("cross_dissolve"),
  transitionFrames: z.number().int().min(1).max(120).default(15),
  kenBurns: z.boolean().default(true),
  kenBurnsDirection: z.enum(["random", "in", "out"]).default("random"),
  kenBurnsStrength: z.number().min(1).max(100).default(20),
  fit: z.enum(["fit", "fill"]).default("fill"),
  colorPreset: z.enum(["none", "contrast", "bw", "warm", "cool"]).default("none"),
  titleFromFilename: z.boolean().default(false),
  titleDurationSec: z.number().min(0.5).max(20).default(2),
  pathMode: z.enum(["dialog", "folder"]).default("dialog"),
  folderPath: z.string().trim().max(500).default(""),
});

export type PremiereOptions = z.infer<typeof premiereOptionsSchema>;

export const defaultPremiereOptions: PremiereOptions = premiereOptionsSchema.parse({});
