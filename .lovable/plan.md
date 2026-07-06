## Neuer Tab: Premiere-Skript-Generator

Ein neuer Top-Level-Tab `/premiere`, in dem der User Bilder per Drag & Drop reinzieht und daraus ein **Adobe Premiere ExtendScript (.jsx)** herunterlädt, das die Bildbearbeitung/-anordnung automatisiert.

### Navigation

- Nav-Link "Premiere" neben Studio/Recordings in `src/routes/__root.tsx`.
- Neue Route-Datei `src/routes/premiere.tsx` mit eigenem `head()` (Title/Description/OG).

### UI (`src/routes/premiere.tsx`)

Eine Seite, kein Multi-Step-Wizard:

1. **Dropzone** (JPG/PNG/WEBP, mehrere Dateien, auch per Datei-Picker). Reihenfolge = Drop-Reihenfolge, per Drag sortierbar (kleine Thumbnails mit Index).
2. **Optionen-Panel** (alles optional, sinnvolle Defaults, da "jegliche Bildbearbeitung" gewünscht ist — wir bieten die gebräuchlichsten Automatisierungen als Toggles):
   - Sequenz-Preset: Framerate (24/25/30/50/60), Auflösung (1920×1080 / 3840×2160 / auto-from-first-image).
   - Clip-Dauer pro Bild (Sekunden, default 3s).
   - Übergang: keiner / Cross Dissolve / Dip to Black (Dauer in Frames).
   - Ken-Burns-Zoom (an/aus, Richtung zufällig/in/out, Stärke %).
   - Auto-Fit: Scale-to-Fit oder Scale-to-Fill.
   - Farbkorrektur-Preset: keiner / +Kontrast / S/W / Warm / Kalt (wird als Lumetri-Basiswerte gesetzt).
   - Titel-Overlay aus Dateinamen (an/aus, Dauer, Position).
   - Ziel-Bin-Name & Sequenz-Name.
3. **Bildpfad-Modus** (wichtig, weil ExtendScript lokale Dateipfade braucht):
   - a) User gibt einen **Ordnerpfad** ein (z. B. `/Users/x/Bilder/shoot1`) und das Skript liest Dateien aus dem Ordner in der eingegebenen Reihenfolge (Dateinamen kommen aus dem Drop).
   - b) Alternative "Portable"-Modus: Skript zeigt beim Start `Folder.selectDialog()` und matcht Dateinamen.
   Default: (b), weil kein Pfad nötig ist.
4. **Buttons**:
   - `Skript herunterladen` → `.jsx`-Datei via Blob-Download.
   - `In Zwischenablage kopieren`.
   - `Vorschau` → Read-only Code-View des generierten Skripts (in einem `<pre>`).
5. **Anleitung** (Accordion): "So führst du das Skript in Premiere aus" — File → Scripts → Run Script File… (bzw. ExtendScript Toolkit).

### Skript-Generierung (`src/lib/premiere/generateJsx.ts`)

Reine clientseitige String-Generierung, keine Backend-Calls, keine Uploads.

- Nimmt `{ files: {name: string}[], options }` und gibt einen ExtendScript-String zurück.
- Struktur des erzeugten `.jsx`:
  1. `#target premierepro`
  2. Helper-Funktionen: `pickFolder()`, `importFile(path)`, `addToSequence(clip, offset)`.
  3. `app.project.newSequence(name, presetPath?)` bzw. `Sequence`-Erstellung über `app.project.createNewSequence(name, id)` + Anpassung von Framerate/Auflösung wo möglich (ExtendScript ist hier limitiert; wir fallen auf ein eingebettetes Preset per `newSequenceFromPresets` mit Standard-Preset-Pfad zurück und dokumentieren das).
  4. Loop über Dateinamen: importieren, an Video-Track 1 anhängen mit `insertClip`, `end += clipDuration`.
  5. Optional: Motion-Keyframes für Ken-Burns via `clip.components["Motion"].properties["Scale"|"Position"].setValueAtKey(...)`.
  6. Optional: Übergänge — `sequence.videoTracks[0].clips[i].applyDefaultTransition()` oder `QE`-DOM-Fallback für Cross Dissolve.
  7. Optional: Lumetri Color-Effekt anhängen mit Preset-Werten (Kontrast, Sättigung, Temperatur).
  8. Optional: Titel-Overlay via `app.project.createNewItem` (Legacy Title) oder MOGRT — wir nehmen Legacy Title als Fallback, weil pfadunabhängig.
- Alle Optionen werden als Konstanten oben im Skript gesetzt, sodass der User sie im .jsx auch direkt editieren kann.

### Utility

- `src/lib/premiere/escapeJsxString.ts` — sicheres Escapen von Dateinamen (Quotes, Backslashes) für den generierten String. Alle User-Inputs (Sequenznamen, Bin-Namen, Pfad) laufen hier durch, plus Zod-Schema für die Optionen im UI.

### Neue/geänderte Dateien

```
src/routes/premiere.tsx                    (neu)
src/components/premiere/PremiereDropzone.tsx (neu — Bilder-Grid + Sort)
src/components/premiere/PremiereOptions.tsx  (neu — Form mit shadcn Inputs/Select/Switch)
src/components/premiere/ScriptPreview.tsx    (neu — Code-Vorschau + Copy/Download)
src/lib/premiere/generateJsx.ts              (neu)
src/lib/premiere/escapeJsxString.ts          (neu)
src/lib/premiere/schema.ts                   (neu — Zod-Schema für Optionen)
src/routes/__root.tsx                        (Nav-Link "Premiere" hinzufügen)
```

`src/routeTree.gen.ts` wird vom TanStack-Router-Plugin automatisch aktualisiert.

### Out of Scope

- Kein Upload der Bilder in die Cloud — alles läuft lokal im Browser; das Skript referenziert nur Dateinamen.
- Kein Rendern/Export aus Premiere heraus (das Skript baut nur die Sequenz).
- Keine UXP-Variante, keine FCPXML-Ausgabe.
- Keine Photoshop-Automation.

### Offene Details

Da "jegliche Bildbearbeitung" sehr breit ist, liefere ich den o. g. Grundstock (Sequenz aus Bildern + Ken Burns + Übergänge + Lumetri-Preset + Titel). Weitere Effekte (Masken, Speed-Ramps, Audio-Beds, spezifische MOGRTs) füge ich in einem Folge-Task hinzu, sobald du konkrete Effekte nennst.
