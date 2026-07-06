import { useCallback, useRef, useState } from "react";
import { Upload, X, GripVertical, ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface DroppedImage {
  id: string;
  name: string;
  size: number;
  url: string;
}

interface Props {
  images: DroppedImage[];
  onChange: (next: DroppedImage[]) => void;
}

const ACCEPT = ["image/jpeg", "image/png", "image/webp"];

export function PremiereDropzone({ images, onChange }: Props) {
  const [hover, setHover] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const add = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) => ACCEPT.includes(f.type));
      const next: DroppedImage[] = list.map((f) => ({
        id: `${f.name}-${f.size}-${crypto.randomUUID()}`,
        name: f.name,
        size: f.size,
        url: URL.createObjectURL(f),
      }));
      onChange([...images, ...next]);
    },
    [images, onChange],
  );

  const remove = (id: string) => {
    const target = images.find((i) => i.id === id);
    if (target) URL.revokeObjectURL(target.url);
    onChange(images.filter((i) => i.id !== id));
  };

  const clearAll = () => {
    images.forEach((i) => URL.revokeObjectURL(i.url));
    onChange([]);
  };

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const next = images.slice();
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHover(false);
          if (e.dataTransfer.files.length) add(e.dataTransfer.files);
        }}
        className={cn(
          "border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer",
          hover ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50",
        )}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-sm font-medium">Bilder hierher ziehen</p>
        <p className="text-xs text-muted-foreground mt-1">JPG · PNG · WEBP — mehrere Dateien möglich</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT.join(",")}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {images.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {images.length} Bild{images.length === 1 ? "" : "er"} · Reihenfolge = Timeline-Reihenfolge
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
                <ImagePlus className="h-3.5 w-3.5 mr-1.5" /> Mehr
              </Button>
              <Button size="sm" variant="ghost" onClick={clearAll}>
                Alle entfernen
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {images.map((img, idx) => (
              <div
                key={img.id}
                draggable
                onDragStart={() => setDragIdx(idx)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIdx !== null) reorder(dragIdx, idx);
                  setDragIdx(null);
                }}
                className="relative group rounded-md overflow-hidden border bg-muted aspect-video"
              >
                <img src={img.url} alt={img.name} className="w-full h-full object-cover" />
                <div className="absolute top-1 left-1 bg-background/90 text-foreground text-xs font-mono rounded px-1.5 py-0.5">
                  {idx + 1}
                </div>
                <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(img.id);
                    }}
                    className="bg-background/90 hover:bg-destructive hover:text-destructive-foreground rounded p-1"
                    aria-label="Entfernen"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1 text-[10px] text-white truncate flex items-center gap-1">
                  <GripVertical className="h-3 w-3 flex-none opacity-70" />
                  <span className="truncate">{img.name}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
