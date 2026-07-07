
-- Full-copy marker column
ALTER TABLE public.recordings
  ADD COLUMN IF NOT EXISTS full_copy boolean NOT NULL DEFAULT false;

-- Ensure RLS is on
ALTER TABLE public.recordings ENABLE ROW LEVEL SECURITY;

-- Grants: authenticated + service_role only, no anon
REVOKE ALL ON public.recordings FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recordings TO authenticated;
GRANT ALL ON public.recordings TO service_role;

-- Drop any prior permissive/anon policies
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='recordings' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.recordings', r.policyname);
  END LOOP;
END $$;

-- Any authenticated user can manage the shared recording library
CREATE POLICY "authenticated read recordings"
  ON public.recordings FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated insert recordings"
  ON public.recordings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "authenticated update recordings"
  ON public.recordings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated delete recordings"
  ON public.recordings FOR DELETE TO authenticated USING (true);

-- Storage: recordings bucket accessible only to authenticated
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname LIKE '%recordings%' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.policyname);
  END LOOP;
END $$;

CREATE POLICY "recordings bucket read (auth)"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'recordings');
CREATE POLICY "recordings bucket insert (auth)"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'recordings');
CREATE POLICY "recordings bucket update (auth)"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'recordings') WITH CHECK (bucket_id = 'recordings');
CREATE POLICY "recordings bucket delete (auth)"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'recordings');
