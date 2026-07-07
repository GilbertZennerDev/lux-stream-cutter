ALTER TABLE public.recordings
  ADD COLUMN IF NOT EXISTS transcript jsonb,
  ADD COLUMN IF NOT EXISTS transcript_srt text,
  ADD COLUMN IF NOT EXISTS transcribed_at timestamptz;