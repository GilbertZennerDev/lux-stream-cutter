
CREATE TABLE public.fonts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  family TEXT NOT NULL,
  original_filename TEXT,
  storage_path TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  is_default BOOLEAN NOT NULL DEFAULT false,
  uploaded_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX fonts_only_one_default ON public.fonts (is_default) WHERE is_default = true;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fonts TO authenticated;
GRANT ALL ON public.fonts TO service_role;

ALTER TABLE public.fonts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read fonts"
  ON public.fonts FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert their own font rows"
  ON public.fonts FOR INSERT TO authenticated WITH CHECK (uploaded_by = auth.uid());

-- Anyone signed-in can flip is_default (fonts are a shared team resource).
CREATE POLICY "Authenticated users can update fonts"
  ON public.fonts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Only the uploader can delete their own row (super_admins bypass via service_role).
CREATE POLICY "Uploader can delete their own font"
  ON public.fonts FOR DELETE TO authenticated USING (uploaded_by = auth.uid());

-- Storage RLS: bucket is private; any signed-in user can read all fonts
-- (needed to render subtitles) and manage their own uploads.
CREATE POLICY "Authenticated can read font files"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'fonts');

CREATE POLICY "Authenticated can upload font files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'fonts' AND owner = auth.uid());

CREATE POLICY "Owner can delete their font files"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'fonts' AND owner = auth.uid());
