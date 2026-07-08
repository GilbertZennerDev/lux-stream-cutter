## Problem

Recordings uploaded by the worker are correctly stored with `group_id = ADR`, and the RLS policies already grant read/update/delete to any group member. But server functions in `src/lib/recordings.functions.ts` add an extra `.eq("user_id", context.userId)` filter on top of RLS, so each user only ever sees rows they personally uploaded. Worker rows (owned by `WORKER_USER_ID`) are invisible to ADR members even though RLS would allow them.

## Fix

Drop the redundant `user_id` filters and let RLS scope visibility. Rows the caller shouldn't touch are already blocked by policy.

Changes in `src/lib/recordings.functions.ts`:

1. `listRecordings` — remove `.eq("user_id", context.userId)`. Return everything RLS allows (own + all group recordings).
2. `getRecordingDownloadUrl` — remove `.eq("user_id", context.userId)` so any ADR member can fetch a signed URL for a group recording.
3. `saveRecordingTranscript` — remove `.eq("user_id", context.userId)` so group members can edit transcripts (RLS UPDATE policy already allows it).
4. `deleteRecording` — remove both `.eq("user_id", context.userId)` calls (RLS DELETE policy already restricts to group members).
5. `markRecordingReady` / `markRecordingFailed` — leave as-is; only the original uploader calls these from the browser recorder, and the worker uses the admin hook.

Optional UX touch (only if you want it — say the word): show the worker recordings with a fallback title like `Session {session_date} · chunk {n}` in the Recordings page when `title` is null, instead of literal "null".

## Verification

After the change, sign in as an ADR member and open Recordings — the 4 READY worker rows should appear and download.
