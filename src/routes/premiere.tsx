import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Film, Scissors, Radio, Library } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { reportLovableError } from "@/lib/lovable-error-reporting";
import { PremiereDropzone, type DroppedImage } from "@/components/premiere/PremiereDropzone";
import { PremiereOptions as PremiereOptionsForm } from "@/components/premiere/PremiereOptions";
import { ScriptPreview } from "@/components/premiere/ScriptPreview";
import { defaultPremiereOptions, type PremiereOptions } from "@/lib/premiere/schema";
import { generateJsx } from "@/lib/premiere/generateJsx";

function PremiereError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "premiere_route" });
  }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Premiere-Tab konnte nicht geladen werden</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <button
          onClick={() => { router.invalidate(); reset(); }}
          className="mt-4 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
        >
          Erneut versuchen
        </button>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/premiere")({
  head: () => ({
    meta: [
      { title: "Premiere Skript-Generator — LuxStream" },
      { name: "description", content: "Bilder per Drag & Drop in ein Adobe Premiere ExtendScript verwandeln: Sequenz, Ken Burns, Übergänge und Farb-Presets automatisch generieren." },
      { property: "og:title", content: "Premiere Skript-Generator — LuxStream" },
      { property: "og:description", content: "Bilder-Drop → fertiges .jsx für Adobe Premiere Pro. Automatisiert Bildbearbeitung im Editor." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PremierePage,
  errorComponent: PremiereError,
});

function PremierePage() {
  const [images, setImages] = useState<DroppedImage[]>([]);
  const [opts, setOpts] = useState<PremiereOptions>(defaultPremiereOptions);

  useEffect(() => () => { images.forEach((i) => URL.revokeObjectURL(i.url)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const script = useMemo(
    () => (images.length ? generateJsx(images.map((i) => ({ name: i.name })), opts) : ""),
    [images, opts],
  );

  const filename = useMemo(() => {
    const safe = opts.sequenceName.replace(/[^A-Za-z0-9-_]+/g, "_") || "premiere_script";
    return `${safe}.jsx`;
  }, [opts.sequenceName]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background/95 backdrop-blur z-10">
        <div className="mx-auto max-w-6xl px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Film className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-base font-semibold leading-tight">Premiere Skript-Generator</h1>
              <p className="text-xs text-muted-foreground">Bilder → Adobe Premiere ExtendScript (.jsx)</p>
            </div>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            <Link to="/" className="px-3 py-1.5 rounded-md hover:bg-muted flex items-center gap-1.5">
              <Scissors className="h-4 w-4" /> Cutter
            </Link>
            <Link to="/studio" className="px-3 py-1.5 rounded-md hover:bg-muted flex items-center gap-1.5">
              <Radio className="h-4 w-4" /> Studio
            </Link>
            <Link to="/recordings" className="px-3 py-1.5 rounded-md hover:bg-muted flex items-center gap-1.5">
              <Library className="h-4 w-4" /> Recordings
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6 grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">1 · Bilder</CardTitle>
            </CardHeader>
            <CardContent>
              <PremiereDropzone images={images} onChange={setImages} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">2 · Optionen</CardTitle>
            </CardHeader>
            <CardContent>
              <PremiereOptionsForm value={opts} onChange={setOpts} />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6 lg:sticky lg:top-20 self-start">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">3 · Skript</CardTitle>
            </CardHeader>
            <CardContent>
              <ScriptPreview script={script} filename={filename} disabled={images.length === 0} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Anleitung</CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion type="single" collapsible defaultValue="run">
                <AccordionItem value="run">
                  <AccordionTrigger className="text-sm">So führst du das Skript in Premiere aus</AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground space-y-2">
                    <ol className="list-decimal pl-5 space-y-1">
                      <li>Öffne Adobe Premiere Pro und erstelle/öffne ein Projekt.</li>
                      <li><b>File → Scripts → Run Script File…</b> und wähle die heruntergeladene <code>.jsx</code>-Datei.</li>
                      <li>Wenn <i>Portabel</i>-Modus: Ordner-Dialog wählt den Ordner mit den Bildern (Dateinamen müssen matchen).</li>
                      <li>Fertig – die Sequenz wird angelegt und die Clips landen auf V1.</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="limits">
                  <AccordionTrigger className="text-sm">Was das Skript kann (und nicht kann)</AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground space-y-1">
                    <p>Automatisch: Import in Bin, Sequenz-Erstellung, Clip-Dauer, Ken-Burns-Zoom (Scale-Keyframes), Cross Dissolve / Dip to Black via QE-DOM.</p>
                    <p>Manuell: Präzise Lumetri-Presets müssen je nach Premiere-Version im UI angewendet werden – das Skript loggt die gewählte Preset-Auswahl.</p>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
