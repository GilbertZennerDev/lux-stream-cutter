
## Scope (Prioritéiten)

5 Punkten aus der Lëscht:

1. Authentifikatioun (Email + Passwuert + Google) — shared workspace, keng per-user Daten
2. Studio UI freeze wärend Opnahm leeft
3. Transcription: Erof-/Eroplueden + Timestamps an Text upassen
4. Snapshot-Kn€äppchen um Cutter Tab → hëlt Live-Snapshot als Source Video
5. Parallel eng komplett Kopie vum ganze Stream mat lafen loossen

D'aner Punkten (Ënnertitel-Position, Bord dënn, Nimm vun uploads upassen, batch delete, ganzen Video ouni Ënnertitel, Audio um Sekonn verréckelen, aner Sallen fannen) bleiwen fir spéider.

---

## 1. Auth (Email + Google, shared workspace)

Kee `profiles` Tabell — jidderee gesäit dee selwechte Recordings-Datebank (shared workspace).

- Configure Supabase: enable Email/Password, keng auto-confirm, enable Google via `configure_social_auth` (managed Lovable OAuth).
- Neie public Route `src/routes/auth.tsx`: Sign-in / Sign-up Form + Google-Kn€äppchen (over `lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin })`).
- Managed protected layout `src/routes/_authenticated/route.tsx` (auto-generéiert, `ssr:false`) — mir schaffen näischt dorunner.
- All existent app-Routen (`/`, `/studio`, `/recordings`, `/premiere`) ënner `_authenticated/` réckelen. Public bleiwen `/auth` an d'webhook-Routen `/api/public/*`.
- Root Route: `onAuthStateChange` Listener registréieren (SIGNED_IN/OUT/USER_UPDATED → `router.invalidate()` + Query-Cache invalidatioun).
- Header/Nav: Sign-out Kn€äppchen mat propperer Cache-Teardown (`cancelQueries` → `clear` → `signOut` → `navigate("/auth", replace:true)`).
- `src/start.ts`: sécher dass Bearer-Middleware ugehaang ass (fir authentifiéiert serverFns).

Recording-serverFns kréien `.middleware([requireSupabaseAuth])` fir dass n€ëmmen ageloggt User schreiwen/lauschtere kënnen. RLS Policies um `recordings` Tabell: `authenticated` däerf alles, `anon` näischt.

## 2. Studio freeze wärend Opnahm

Am `src/routes/studio.tsx`:
- Wann `isRecording === true`, disabléieren:
  - URL Input Feld
  - "Ophuelen" / "Setup" Kn€äppchen wéi Start/Sender-Auswiel
  - Preview interval Setting
- N€ëmme "Stop" a "Snapshot" bleiwen enabled.
- Visuell Indikator (roude Punkt + "OPNAHM LEEFT") am Header vun der Studio-Kaart.
- Kee Route-Wechsel-Blocker — user kann d'Säit verloossen, mais UI-Controls sinn agefruer.

## 3. Transcription Editor

Neit Panel um Recordings Tab (oder Modal) fir eng gewielt Opnahm:

**Eroflueden:** existent (SRT Download). Format-Kn€äppchen fir SRT an VTT (VTT = kleng conv).

**Eroplueden:** File-Input akzeptéiert `.srt`; parse zu Cues; iwwerschreiwt Transcript vun der Opnahm iwwer `saveRecordingTranscript` serverFn.

**Editéieren:** Lëscht vun de Cues mat:
- Zwee Zäit-Inputs (start/end in `mm:ss.mmm`)
- Textarea fir Text
- Späichere-Kn€äppchen → rufft `saveRecordingTranscript` op mat komplett rekonstruéiertem SRT.
- Split/Merge/Delete Cue Actions (optional; einfach Delete + neie Cue tëschendran).

Neie File `src/lib/subtitles/parseSrt.ts` fir SRT → `SrtCue[]`.

## 4. Snapshot Kn€äppchen um Cutter

Am `src/routes/index.tsx` (Cutter):
- Nieft der Source-Video Zone: URL-Input + "Snapshot vum Live-Stream" Kn€äppchen.
- Klick → benotzt existent HLS Recorder (`src/lib/hls/recorder.ts`) fir e kuerze Snapshot (z.B. lescht 30s vum Live-Playlist) ze zéien, remuxéiert direkt zu MP4 iwwer `remuxTsToMp4`, an lued et an d'Source Video Slot — genau esou wéi wann e Recording iwwer "Cut" gelueden ass.
- Kee Späicheren an d'Datebank; direkt am Browser benotzt.
- Ládebalken/Progress wärend d'Playlist gepollt an remuxéiert gëtt.

## 5. Parallel komplett Kopie vum Stream

Am `src/lib/hls/scheduled-recorder.ts` (oder Studio Level):
- Nieft de "Chunk"-Recordings (déi elo scho geschnidde no Zäit-Slots opgeholl gi) leeft e **zweeten Recorder** op der selwechter Playlist, ouni Chunk-Grenzen — sammelt all Segmenter vun Start bis Stop an eng eenzeg Datei.
- Beim `stop()` gëtt dës komplett Datei och an de `recordings` Bucket geluede mat `chunk_index = -1` (oder neie `is_full_copy` boolean; simpler: `title = "Full session"` + `chunk_index = -1`).
- UI: neie Toggle "Voll Kopie vum Stream mat opzehuelen" am Studio Setup, default un.

Kee separate ffmpeg-Aarbecht — mir concatenéieren TS-Segmenter genau wéi d'Chunks, just ouni ze rotéieren.

---

## Technesch Notzen (fir Devs)

- Migratioun: RLS Policies um `recordings`, plus `GRANT ... TO authenticated`, `REVOKE ... FROM anon`.
- Bestehend Recordings bleiwen sichtbar (kee `user_id` Filter).
- Google OAuth: `redirect_uri: window.location.origin` (public route), no Session-Hydratatioun `navigate` op `/` (Cutter).
- Studio-Route ass elo protected → `/_authenticated/studio.tsx`; File-Bewegung upassen an all internen Linken (`<Link to="/studio">` bleift datselwecht Pfad, nëmmen d'Datei réckelt).

## Files am Fokus

- neit: `src/routes/auth.tsx`, `src/lib/subtitles/parseSrt.ts`, `src/components/recordings/TranscriptEditor.tsx`
- geännert: `src/routes/__root.tsx` (onAuthStateChange + Nav mat Sign-out), `src/routes/studio.tsx` (freeze), `src/routes/index.tsx` (Snapshot Kn€äppchen), `src/routes/recordings.tsx` (Transcript editor entry), `src/lib/hls/scheduled-recorder.ts` (parallel full copy), `src/lib/recordings.functions.ts` (auth middleware), `src/start.ts` (bearer attacher check)
- move: existent Routen → `src/routes/_authenticated/`
- Migratioun: RLS + GRANTs um `recordings`
