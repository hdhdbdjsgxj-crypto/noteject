-- Apply to an existing Free Supabase project to raise Noteject's bucket cap
-- from 20 MiB to the provider's 50 MB individual-file ceiling.
begin;
update storage.buckets
  set file_size_limit = 52428800,
      public = false,
      allowed_mime_types = array['application/zip']
  where id = 'noteject-workspaces';
commit;
