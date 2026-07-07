
-- Add user ownership to recordings
ALTER TABLE public.recordings ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- Remove existing orphan recordings without an owner (no way to attribute them safely)
DELETE FROM public.recordings WHERE user_id IS NULL;

ALTER TABLE public.recordings ALTER COLUMN user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS recordings_user_id_idx ON public.recordings(user_id);

-- Replace permissive policies with owner-scoped ones
DROP POLICY IF EXISTS "authenticated read recordings" ON public.recordings;
DROP POLICY IF EXISTS "authenticated insert recordings" ON public.recordings;
DROP POLICY IF EXISTS "authenticated update recordings" ON public.recordings;
DROP POLICY IF EXISTS "authenticated delete recordings" ON public.recordings;

CREATE POLICY "Users read own recordings" ON public.recordings
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own recordings" ON public.recordings
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own recordings" ON public.recordings
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own recordings" ON public.recordings
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Storage: scope by first path segment = user id
DROP POLICY IF EXISTS "recordings bucket read (auth)" ON storage.objects;
DROP POLICY IF EXISTS "recordings bucket insert (auth)" ON storage.objects;
DROP POLICY IF EXISTS "recordings bucket update (auth)" ON storage.objects;
DROP POLICY IF EXISTS "recordings bucket delete (auth)" ON storage.objects;

CREATE POLICY "Users read own recording files" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'recordings' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users insert own recording files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'recordings' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users update own recording files" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'recordings' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'recordings' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users delete own recording files" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'recordings' AND (storage.foldername(name))[1] = auth.uid()::text);
