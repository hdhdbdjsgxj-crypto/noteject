-- Run this once in the Supabase SQL Editor for the Noteject project.
-- The workspace bucket is private; all object paths begin with the authenticated user's UUID.

create table if not exists public.workspace_sync_heads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision integer not null default 0 check (revision >= 0),
  snapshot_path text,
  archive_size bigint not null default 0 check (archive_size >= 0),
  device_label text not null default 'Noteject device',
  updated_at timestamptz not null default now(),
  check ((revision = 0 and snapshot_path is null) or (revision > 0 and snapshot_path is not null))
);
alter table public.workspace_sync_heads enable row level security;
drop policy if exists "Users read their own workspace sync head" on public.workspace_sync_heads;
create policy "Users read their own workspace sync head" on public.workspace_sync_heads
  for select to authenticated using (user_id = (select auth.uid()));

create table if not exists public.ai_usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'reserved' check (status in ('reserved', 'complete', 'failed')),
  model text,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists ai_usage_events_user_month on public.ai_usage_events(user_id, created_at desc);
alter table public.ai_usage_events enable row level security;
drop policy if exists "Users read their own AI usage" on public.ai_usage_events;
create policy "Users read their own AI usage" on public.ai_usage_events
  for select to authenticated using (user_id = (select auth.uid()));

-- Billing and server-only AI metering are installed by billing.sql after this script.

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
  if p_expected_revision < 0 or p_archive_size < 1 or p_archive_size > 536870912 then raise exception 'Invalid workspace snapshot'; end if;
  if left(coalesce(p_snapshot_path, ''), length(v_user::text) + 1) <> v_user::text || '/' then raise exception 'Invalid snapshot owner'; end if;
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

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('noteject-workspaces', 'noteject-workspaces', false, 52428800, array['application/zip'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users upload their own Noteject workspace archives" on storage.objects;
create policy "Users upload their own Noteject workspace archives" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'noteject-workspaces' and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "Users download their own Noteject workspace archives" on storage.objects;
create policy "Users download their own Noteject workspace archives" on storage.objects
  for select to authenticated using (
    bucket_id = 'noteject-workspaces' and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "Users delete their own Noteject workspace archives" on storage.objects;
create policy "Users delete their own Noteject workspace archives" on storage.objects
  for delete to authenticated using (
    bucket_id = 'noteject-workspaces' and (storage.foldername(name))[1] = (select auth.uid())::text
  );
