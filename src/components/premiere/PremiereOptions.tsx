import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PremiereOptions } from "@/lib/premiere/schema";

interface Props {
  value: PremiereOptions;
  onChange: (next: PremiereOptions) => void;
}

export function PremiereOptions({ value, onChange }: Props) {
  const set = <K extends keyof PremiereOptions>(k: K, v: PremiereOptions[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Sequenz-Name">
        <Input value={value.sequenceName} onChange={(e) => set("sequenceName", e.target.value)} />
      </Field>
      <Field label="Bin-Name">
        <Input value={value.binName} onChange={(e) => set("binName", e.target.value)} />
      </Field>

      <Field label="Framerate">
        <Select value={String(value.frameRate)} onValueChange={(v) => set("frameRate", Number(v) as PremiereOptions["frameRate"])}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {[24, 25, 30, 50, 60].map((n) => <SelectItem key={n} value={String(n)}>{n} fps</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Auflösung">
        <Select value={value.resolution} onValueChange={(v) => set("resolution", v as PremiereOptions["resolution"])}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1920x1080">1920×1080 (HD)</SelectItem>
            <SelectItem value="3840x2160">3840×2160 (4K)</SelectItem>
            <SelectItem value="auto">Auto (erstes Bild)</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label={`Clip-Dauer: ${value.clipDurationSec}s`}>
        <Input
          type="number" min={0.1} step={0.1} max={60}
          value={value.clipDurationSec}
          onChange={(e) => set("clipDurationSec", Number(e.target.value) || 0.1)}
        />
      </Field>
      <Field label="Fit-Modus">
        <Select value={value.fit} onValueChange={(v) => set("fit", v as PremiereOptions["fit"])}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="fill">Fill (füllen, ggf. beschneiden)</SelectItem>
            <SelectItem value="fit">Fit (einpassen, Ränder)</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Übergang">
        <Select value={value.transition} onValueChange={(v) => set("transition", v as PremiereOptions["transition"])}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Kein</SelectItem>
            <SelectItem value="cross_dissolve">Cross Dissolve</SelectItem>
            <SelectItem value="dip_to_black">Dip to Black</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={`Übergangs-Dauer (Frames): ${value.transitionFrames}`}>
        <Input
          type="number" min={1} max={120} step={1}
          value={value.transitionFrames}
          onChange={(e) => set("transitionFrames", Math.max(1, Number(e.target.value) || 1))}
        />
      </Field>

      <Field label="Farb-Preset">
        <Select value={value.colorPreset} onValueChange={(v) => set("colorPreset", v as PremiereOptions["colorPreset"])}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Kein</SelectItem>
            <SelectItem value="contrast">Punchy Kontrast</SelectItem>
            <SelectItem value="bw">Schwarz/Weiß</SelectItem>
            <SelectItem value="warm">Warm</SelectItem>
            <SelectItem value="cool">Kalt</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Bildpfad-Modus">
        <Select value={value.pathMode} onValueChange={(v) => set("pathMode", v as PremiereOptions["pathMode"])}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="dialog">Ordner beim Start wählen (portabel)</SelectItem>
            <SelectItem value="folder">Fixer Pfad</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {value.pathMode === "folder" && (
        <Field label="Ordner-Pfad" full>
          <Input
            placeholder="/Users/…/Bilder/shoot1"
            value={value.folderPath}
            onChange={(e) => set("folderPath", e.target.value)}
          />
        </Field>
      )}

      <div className="sm:col-span-2 border-t pt-3 space-y-3">
        <ToggleRow label="Ken-Burns-Zoom" checked={value.kenBurns} onChange={(b) => set("kenBurns", b)} />
        {value.kenBurns && (
          <div className="grid sm:grid-cols-2 gap-3 pl-4">
            <Field label="Richtung">
              <Select value={value.kenBurnsDirection} onValueChange={(v) => set("kenBurnsDirection", v as PremiereOptions["kenBurnsDirection"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="random">Zufällig</SelectItem>
                  <SelectItem value="in">Zoom In</SelectItem>
                  <SelectItem value="out">Zoom Out</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={`Stärke: ${value.kenBurnsStrength}%`}>
              <Input
                type="number" min={1} max={100} step={1}
                value={value.kenBurnsStrength}
                onChange={(e) => set("kenBurnsStrength", Math.max(1, Math.min(100, Number(e.target.value) || 20)))}
              />
            </Field>
          </div>
        )}

        <ToggleRow label="Titel-Overlay aus Dateinamen" checked={value.titleFromFilename} onChange={(b) => set("titleFromFilename", b)} />
        {value.titleFromFilename && (
          <div className="pl-4">
            <Field label={`Titel-Dauer: ${value.titleDurationSec}s`}>
              <Input
                type="number" min={0.5} max={20} step={0.5}
                value={value.titleDurationSec}
                onChange={(e) => set("titleDurationSec", Number(e.target.value) || 2)}
              />
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? "sm:col-span-2 space-y-1.5" : "space-y-1.5"}>
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (b: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-sm">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
