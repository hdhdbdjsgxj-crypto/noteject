-- Run after schema.sql and billing.sql, and after upgrading the Supabase project
-- to Pro. The Pro storage service is required for files larger than 50 MB.
begin;

create or replace function public.noteject_workspace_backup_quota()
returns bigint
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_plan text := 'free';
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  -- Production/live subscriptions determine customer entitlements. Sandbox
  -- subscriptions cannot grant larger production storage limits.
  select plan_id into v_plan
    from public.noteject_subscriptions
    where user_id = auth.uid()
      and livemode = true
      and status in ('active', 'trialing')
      and period_end > now()
    order by case plan_id when 'team' then 3 when 'pro' then 2 when 'starter' then 1 else 0 end desc,
      observed_at desc
    limit 1;

  return case coalesce(v_plan, 'free')
    when 'starter' then 1073741824
    when 'pro' then 5368709120
    when 'team' then 16106127360
    else 52428800
  end;
end;
$$;
revoke all on function public.noteject_workspace_backup_quota() from public, anon;
grant execute on function public.noteject_workspace_backup_quota() to authenticated, service_role;

-- ZIP64 portable backups support archives up to 15 GiB. Supabase Pro supports
-- larger uploads; the application's plan limits remain lower than the provider cap.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('noteject-workspaces', 'noteject-workspaces', false, 16106127360, array['application/zip'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users upload their own Noteject workspace archives" on storage.objects;
create policy "Users upload their own Noteject workspace archives" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'noteject-workspaces'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and coalesce(metadata->>'size', '') ~ '^[0-9]+$'
    and (metadata->>'size')::bigint between 1 and public.noteject_workspace_backup_quota()
  );

create or replace function public.noteject_advance_workspace(
  p_expected_revision integer,
  p_snapshot_path text,
  p_archive_size bigint,
  p_device_label text
) returns integer language plpgsql security definer set search_path = public, auth
as $$
declare
  v_user uuid := auth.uid();
  v_revision integer;
  v_new_revision integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_expected_revision < 0 or p_archive_size < 1
    or p_archive_size > public.noteject_workspace_backup_quota() then
    raise exception 'Backup exceeds this plan storage limit';
  end if;
  if left(coalesce(p_snapshot_path, ''), length(v_user::text) + 1) <> v_user::text || '/' then
    raise exception 'Invalid snapshot owner';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_user::text));
  select revision into v_revision from public.workspace_sync_heads where user_id = v_user for update;
  if not found then
    if p_expected_revision <> 0 then raise exception 'WORKSPACE_SYNC_CONFLICT'; end if;
    v_new_revision := 1;
    insert into public.workspace_sync_heads(user_id, revision, snapshot_path, archive_size, device_label, updated_at)
      values (v_user, v_new_revision, p_snapshot_path, p_archive_size, left(coalesce(p_device_label, 'Noteject device'), 80), now());
  else
    if v_revision <> p_expected_revision then raise exception 'WORKSPACE_SYNC_CONFLICT'; end if;
    v_new_revision := v_revision + 1;
    update public.workspace_sync_heads set revision = v_new_revision, snapshot_path = p_snapshot_path,
      archive_size = p_archive_size, device_label = left(coalesce(p_device_label, 'Noteject device'), 80), updated_at = now()
      where user_id = v_user;
  end if;
  return v_new_revision;
end;
$$;
revoke all on function public.noteject_advance_workspace(integer, text, bigint, text) from public;
grant execute on function public.noteject_advance_workspace(integer, text, bigint, text) to authenticated;

commit;
