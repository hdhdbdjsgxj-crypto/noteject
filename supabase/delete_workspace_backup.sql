-- Apply once to an existing Noteject project to enable the account's
-- Delete cloud backup action. It only clears the signed-in user's sync head.
create or replace function public.noteject_clear_workspace(
  p_expected_revision integer,
  p_snapshot_path text
) returns boolean language plpgsql security definer set search_path = public, auth
as $$
declare
  v_user uuid := auth.uid();
  v_revision integer;
  v_snapshot_path text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_expected_revision is null or p_expected_revision < 1
    or left(coalesce(p_snapshot_path, ''), length(v_user::text) + 1) <> v_user::text || '/' then
    raise exception 'Invalid workspace snapshot';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_user::text));
  select revision, snapshot_path into v_revision, v_snapshot_path
    from public.workspace_sync_heads where user_id = v_user for update;
  if not found then return true; end if;
  if v_revision <> p_expected_revision or v_snapshot_path <> p_snapshot_path then
    raise exception 'WORKSPACE_SYNC_CONFLICT';
  end if;
  delete from public.workspace_sync_heads where user_id = v_user;
  return true;
end;
$$;
revoke all on function public.noteject_clear_workspace(integer, text) from public;
grant execute on function public.noteject_clear_workspace(integer, text) to authenticated;
