CREATE OR REPLACE FUNCTION app_private.has_group_access(_user_id uuid, _group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT app_private.is_super_admin(_user_id)
      OR EXISTS (
        SELECT 1 FROM public.group_members
        WHERE user_id = _user_id AND group_id = _group_id
      );
$function$;