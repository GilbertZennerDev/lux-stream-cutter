import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload, Trash2, Loader2, Star, StarOff, Download } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type FontRow = {
  id: string;
  family: string;
  original_filename: string | null;
  storage_path: string;
  format: string;
  size_bytes: number;
  status: string;
  is_default: boolean;
  uploaded_by: string;
  created_at: string;
};

const ACCEPT_EXT = ["ttf", "otf", "woff", "woff2"];
const ACCEPT_ATTR = ACCEPT_EXT.map((e) => `.${e}`).join(",");

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function familyFromName(name: string) {
  const stem = name.replace(/\.[^.]+$/, "");
  return stem.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || stem;
}

function extOf(name: string) {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

function sanitize(name: string) {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function FontsManager() {
  const qc = useQueryClient();
  const [hover, setHover] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fontsQuery = useQuery({
    queryKey: ["fonts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fonts")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as FontRow[];
    },
  });

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData.user) {
        toast.error("Not signed in");
        return;
      }
      const uid = userData.user.id;
      const list = Array.from(files).filter((f) => ACCEPT_EXT.includes(extOf(f.name)));
      if (!list.length) {
        toast.error("Only .ttf, .otf, .woff, .woff2 accepted");
        return;
      }
      for (const file of list) {
        setUploading(file.name);
        const ext = extOf(file.name);
        const storage_path = `${uid}/${crypto.randomUUID()}-${sanitize(file.name)}`;
        try {
          const { error: upErr } = await supabase.storage
            .from("fonts")
            .upload(storage_path, file, {
              contentType: file.type || `font/${ext}`,
              upsert: false,
            });
          if (upErr) throw upErr;

          const { error: insErr } = await supabase.from("fonts").insert({
            family: familyFromName(file.name),
            original_filename: file.name,
            storage_path,
            format: ext,
            size_bytes: file.size,
            status: "ready",
            uploaded_by: uid,
          });
          if (insErr) {
            await supabase.storage.from("fonts").remove([storage_path]);
            throw insErr;
          }
          toast.success(`Uploaded ${file.name}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          toast.error(`Failed: ${file.name} — ${msg}`);
        }
      }
      setUploading(null);
      qc.invalidateQueries({ queryKey: ["fonts"] });
    },
    [qc],
  );

  const deleteMut = useMutation({
    mutationFn: async (row: FontRow) => {
      const { error: rmErr } = await supabase.storage.from("fonts").remove([row.storage_path]);
      if (rmErr) throw rmErr;
      const { error: delErr } = await supabase.from("fonts").delete().eq("id", row.id);
      if (delErr) throw delErr;
    },
    onSuccess: () => {
      toast.success("Font deleted");
      qc.invalidateQueries({ queryKey: ["fonts"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const setDefaultMut = useMutation({
    mutationFn: async (row: FontRow) => {
      const { error: clearErr } = await supabase
        .from("fonts")
        .update({ is_default: false })
        .eq("is_default", true);
      if (clearErr) throw clearErr;
      const { error: setErr } = await supabase
        .from("fonts")
        .update({ is_default: true })
        .eq("id", row.id);
      if (setErr) throw setErr;
    },
    onSuccess: () => {
      toast.success("Default font updated");
      qc.invalidateQueries({ queryKey: ["fonts"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const download = async (row: FontRow) => {
    const { data, error } = await supabase.storage.from("fonts").download(row.storage_path);
    if (error || !data) {
      toast.error(error?.message ?? "Download failed");
      return;
    }
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = row.original_filename ?? `${row.family}.${row.format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Fonts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setHover(true);
          }}
          onDragLeave={() => setHover(false)}
          onDrop={(e) => {
            e.preventDefault();
            setHover(false);
            if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors",
            hover ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50",
          )}
        >
          {uploading ? (
            <div className="flex items-center justify-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Uploading {uploading}…
            </div>
          ) : (
            <>
              <Upload className="mx-auto h-6 w-6 text-muted-foreground mb-2" />
              <p className="text-sm font-medium">Drop font files here</p>
              <p className="text-xs text-muted-foreground mt-1">
                .ttf · .otf · .woff · .woff2 — full file content is stored
              </p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT_ATTR}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) upload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        <div className="border rounded-md divide-y">
          {fontsQuery.isLoading && (
            <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {fontsQuery.data && fontsQuery.data.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">No fonts uploaded yet.</div>
          )}
          {fontsQuery.data?.map((row) => (
            <div key={row.id} className="p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{row.family}</span>
                  <Badge variant="secondary" className="text-[10px] uppercase">{row.format}</Badge>
                  {row.is_default && (
                    <Badge className="text-[10px]"><Star className="h-3 w-3 mr-1" /> Default</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {row.original_filename} · {formatSize(row.size_bytes)} ·{" "}
                  {new Date(row.created_at).toLocaleString()}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => download(row)}
                title="Download original bytes"
              >
                <Download className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={row.is_default || setDefaultMut.isPending}
                onClick={() => setDefaultMut.mutate(row)}
                title={row.is_default ? "Already default" : "Set as default"}
              >
                {row.is_default ? <Star className="h-4 w-4" /> : <StarOff className="h-4 w-4" />}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={deleteMut.isPending}
                onClick={() => {
                  if (confirm(`Delete ${row.family}?`)) deleteMut.mutate(row);
                }}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
