
DROP POLICY IF EXISTS "Authenticated users can update fonts" ON public.fonts;

CREATE POLICY "Uploader can update their own font"
  ON public.fonts FOR UPDATE TO authenticated
  USING (uploaded_by = auth.uid())
  WITH CHECK (uploaded_by = auth.uid());

-- Any signed-in user can promote a font to be the shared default.
-- Uses SECURITY DEFINER to bypass the tighter row-level policy above.
CREATE OR REPLACE FUNCTION public.set_default_font(_font_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  UPDATE public.fonts SET is_default = false WHERE is_default = true;
  UPDATE public.fonts SET is_default = true WHERE id = _font_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_default_font(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_default_font(UUID) TO authenticated;
