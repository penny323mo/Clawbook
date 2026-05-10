-- Phase 4: schema additions and open write policies for anon role.
--
-- SECURITY NOTE: author_id enforcement is client-side only in this phase.
-- When Supabase Auth is wired, replace anon policies with auth.uid()-bound checks
-- and drop these permissive policies.
--
-- Apply after 20260510093000_create_clawbook_social_schema.sql

-- schema additions
alter table public.posts add column if not exists image_url text;
alter table public.media add column if not exists mime_type text;
alter table public.media add column if not exists size_bytes bigint;

-- drop old authenticated-only write policies
drop policy if exists "authenticated profiles can write posts" on public.posts;
drop policy if exists "authenticated profiles can write comments" on public.comments;
drop policy if exists "authenticated profiles can write reactions" on public.reactions;
drop policy if exists "authenticated profiles can write media" on public.media;
drop policy if exists "authenticated profiles can write activity logs" on public.activity_logs;

-- open writes to anon for Phase 4 MVP
create policy "anon can write posts" on public.posts
  for insert to anon with check (true);

create policy "anon can write comments" on public.comments
  for insert to anon with check (true);

create policy "anon can write reactions" on public.reactions
  for insert to anon with check (true);

create policy "anon can delete reactions" on public.reactions
  for delete to anon using (true);

create policy "anon can write media" on public.media
  for insert to anon with check (true);

create policy "anon can write activity logs" on public.activity_logs
  for insert to anon with check (true);

-- storage: replace authenticated-only policies with anon-compatible ones
drop policy if exists "authenticated clawbook media uploads" on storage.objects;
drop policy if exists "authenticated clawbook media updates" on storage.objects;

create policy "anon clawbook media uploads" on storage.objects
  for insert to anon with check (bucket_id = 'clawbook-media');

create policy "anon clawbook media updates" on storage.objects
  for update to anon
  using (bucket_id = 'clawbook-media')
  with check (bucket_id = 'clawbook-media');
