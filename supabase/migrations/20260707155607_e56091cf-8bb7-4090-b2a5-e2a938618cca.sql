
-- 1) Private schema for internal helpers
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
REVOKE ALL ON SCHEMA app_private FROM anon, authenticated;
GRANT USAGE ON SCHEMA app_private TO postgres, service_role;

-- 2) Move SECURITY DEFINER helpers out of public into app_private.
--    RLS policies and triggers that reference these functions store the
--    OID, so they follow the move transparently.
ALTER FUNCTION public.has_role(uuid, public.app_role) SET SCHEMA app_private;
ALTER FUNCTION public.is_super_admin(uuid) SET SCHEMA app_private;
ALTER FUNCTION public.current_group_id(uuid) SET SCHEMA app_private;
ALTER FUNCTION public.has_group_access(uuid, uuid) SET SCHEMA app_private;
ALTER FUNCTION public.grant_super_admin_for_owner() SET SCHEMA app_private;
ALTER FUNCTION public.set_recording_group() SET SCHEMA app_private;
ALTER FUNCTION public.update_updated_at_column() SET SCHEMA app_private;

-- 3) Lock down execute privileges: only the DB-internal roles can call them.
REVOKE ALL ON FUNCTION app_private.has_role(uuid, public.app_role) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.is_super_admin(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.current_group_id(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.has_group_access(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.grant_super_admin_for_owner() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.set_recording_group() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.update_updated_at_column() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION app_private.has_role(uuid, public.app_role) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION app_private.is_super_admin(uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION app_private.current_group_id(uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION app_private.has_group_access(uuid, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION app_private.grant_super_admin_for_owner() TO postgres, service_role;
GRANT EXECUTE ON FUNCTION app_private.set_recording_group() TO postgres, service_role;
GRANT EXECUTE ON FUNCTION app_private.update_updated_at_column() TO postgres, service_role;
