CREATE POLICY "Authenticated users can upload own fonts" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'fonts' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Authenticated users can read fonts objects" ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'fonts');

CREATE POLICY "Uploader can delete own font objects" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'fonts' AND auth.uid()::text = (storage.foldername(name))[1]);