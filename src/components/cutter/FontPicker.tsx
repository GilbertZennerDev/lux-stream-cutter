import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, Star, StarOff, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  createFontUpload,
  deleteFont,
  markFontReady,
  setDefaultFont,
  type FontRow,
} from "@/lib/fonts.functions";
import { useFonts } from "@/lib/fonts/useFonts";

const DEFAULT_FAMILY_LABEL = "Noto Sans (built-in)";
const DEFAULT_FAMILY_VALUE = "__default__";
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXT = /\.(ttf|otf|woff2?|)$/i;

function extractFamily(filename: string): string {
  const stem = filename.replace(/\.(ttf|otf|woff2?|)$/i, "").trim();
  // Normalise separators to spaces; keep alnum + spaces + hyphens.
  const cleaned = stem.replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || stem || "Custom Font";
}

function extractFormat(filename: string): "ttf" | "otf" | "woff" | "woff2" | null {
  const m = filename.toLowerCase().match(/\.(ttf|otf|woff2|woff)$/);
  return (m?.[1] as "ttf" | "otf" | "woff" | "woff2" | undefined) ?? null;
}

interface Props {
  /** Currently selected family name, or null for the built-in default. */
  value: string | null;
  onChange: (family: string | null) => void;
  /** Current signed-in user id — used to decide whether Delete shows. */
  currentUserId?: string | null;
}

export function FontPicker({ value, onChange, currentUserId }: Props) {
  const { fonts, defaultFont } = useFonts();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createUpload = useServerFn(createFontUpload);
  const markReady = useServerFn(markFontReady);
  const setDefault = useServerFn(setDefaultFont);
  const removeFont = useServerFn(deleteFont);

  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Auto-select the shared default the first time it becomes available and
  // the user hasn't picked anything yet.
  useEffect(() => {
    if (value === null && defaultFont) onChange(defaultFont.family);
  }, [defaultFont, value, onChange]);

  const selected: FontRow | null =
    value ? fonts.find((f) => f.family === value && f.status === "ready") ?? null : null;

  const openPicker = () => fileInputRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (!ALLOWED_EXT.test(file.name)) {
      toast.error("Unsupported file. Use .ttf, .otf, .woff, or .woff2");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("Font is too large (max 5 MB).");
      return;
    }
    const format = extractFormat(file.name);
    if (!format) {
      toast.error("Could not determine font format.");
      return;
    }
    const family = extractFamily(file.name);

    setUploading(true);
    try {
      const res = await createUpload({
        data: { filename: file.name, sizeBytes: file.size, format, family },
      });
      // Direct PUT to the signed URL.
      const put = await fetch(res.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "font/" + format },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      await markReady({ data: { id: res.id } });
      await qc.invalidateQueries({ queryKey: ["fonts"] });
      onChange(family);
      toast.success(`Font "${family}" uploaded`);
    } catch (err) {
      toast.error((err as Error).message || "Font upload failed");
    } finally {
      setUploading(false);
    }
  };

  const onSetDefault = async () => {
    if (!selected) return;
    setBusyId(selected.id);
    try {
      await setDefault({ data: { id: selected.id } });
      await qc.invalidateQueries({ queryKey: ["fonts"] });
      toast.success(`"${selected.family}" is now the shared default`);
    } catch (err) {
      toast.error((err as Error).message || "Could not set default");
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async () => {
    if (!selected) return;
    if (!confirm(`Delete font "${selected.family}"?`)) return;
    setBusyId(selected.id);
    try {
      await removeFont({ data: { id: selected.id } });
      await qc.invalidateQueries({ queryKey: ["fonts"] });
      onChange(defaultFont && defaultFont.id !== selected.id ? defaultFont.family : null);
      toast.success("Font deleted");
    } catch (err) {
      toast.error((err as Error).message || "Could not delete font");
    } finally {
      setBusyId(null);
    }
  };

  // Ignore the built-in fallback when Supabase auth hasn't given us a user id;
  // fall back to reading it lazily.
  const [uid, setUid] = useState<string | null>(currentUserId ?? null);
  useEffect(() => {
    if (currentUserId) { setUid(currentUserId); return; }
    supabase.auth.getUser().then(({ data }) => setUid(data.user?.id ?? null));
  }, [currentUserId]);

  const canDelete = !!selected && !!uid && selected.uploadedBy === uid;
  const isCurrentDefault = !!selected && selected.isDefault;

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-[220px]">
        <Label className="text-xs">Font</Label>
        <Select
          value={value ?? DEFAULT_FAMILY_VALUE}
          onValueChange={(v) => onChange(v === DEFAULT_FAMILY_VALUE ? null : v)}
        >
          <SelectTrigger className="h-9">
            <SelectValue>
              <span style={{ fontFamily: value ? `"${value}", sans-serif` : undefined }}>
                {value ?? DEFAULT_FAMILY_LABEL}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_FAMILY_VALUE}>
              {DEFAULT_FAMILY_LABEL}
              {!defaultFont && <span className="ml-2 text-[10px] text-muted-foreground">default</span>}
            </SelectItem>
            {fonts
              .filter((f) => f.status === "ready")
              .map((f) => (
                <SelectItem key={f.id} value={f.family}>
                  <span className="flex items-center gap-2">
                    <span style={{ fontFamily: `"${f.family}", sans-serif` }}>{f.family}</span>
                    {f.isDefault && <Star className="h-3 w-3 fill-current text-amber-500" />}
                  </span>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={openPicker}
        disabled={uploading}
        title="Upload a .ttf, .otf, .woff, or .woff2 file (max 5 MB)"
      >
        {uploading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
        Upload font
      </Button>

      {selected && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSetDefault}
            disabled={busyId === selected.id || isCurrentDefault}
            title={isCurrentDefault ? "Already the shared default" : "Set as shared default for everyone"}
          >
            {isCurrentDefault ? (
              <><Star className="h-3.5 w-3.5 mr-1 fill-current text-amber-500" /> Default</>
            ) : (
              <><StarOff className="h-3.5 w-3.5 mr-1" /> Set as default</>
            )}
          </Button>
          {canDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={busyId === selected.id}
              title="Delete this font (only your uploads)"
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          )}
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
        className="hidden"
        onChange={onFile}
      />
    </div>
  );
}
