
DROP POLICY IF EXISTS "Public read recordings" ON public.recordings;
DROP POLICY IF EXISTS "Public insert recordings" ON public.recordings;
DROP POLICY IF EXISTS "Public update recordings" ON public.recordings;
DROP POLICY IF EXISTS "Public delete recordings" ON public.recordings;

REVOKE ALL ON public.recordings FROM anon, authenticated;
GRANT ALL ON public.recordings TO service_role;
-- No policies for anon/authenticated: table is only reachable via server code
-- (service role bypasses RLS). Storage bucket 'recordings' is private and
-- accessed only through signed URLs minted by server functions.
