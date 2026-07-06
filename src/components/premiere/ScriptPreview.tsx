import { Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface Props {
  script: string;
  filename: string;
  disabled?: boolean;
}

export function ScriptPreview({ script, filename, disabled }: Props) {
  const download = () => {
    const blob = new Blob([script], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success("Skript heruntergeladen");
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(script);
      toast.success("In Zwischenablage kopiert");
    } catch {
      toast.error("Kopieren fehlgeschlagen");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={download} disabled={disabled}>
          <Download className="h-4 w-4 mr-2" /> Skript herunterladen (.jsx)
        </Button>
        <Button variant="outline" onClick={copy} disabled={disabled}>
          <Copy className="h-4 w-4 mr-2" /> Kopieren
        </Button>
      </div>
      <pre className="bg-muted rounded-md p-3 text-xs overflow-auto max-h-96 font-mono leading-relaxed">
        {disabled ? "// Zieh zuerst Bilder in die Dropzone." : script}
      </pre>
    </div>
  );
}
