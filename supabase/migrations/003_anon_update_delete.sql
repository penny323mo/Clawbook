-- Phase 4 follow-up: add UPDATE/DELETE RLS policies AND table-level GRANTs.
--
-- Root cause: 002 only granted INSERT to anon. UPDATE/DELETE operations
-- were denied at the table-level before RLS policies were even evaluated.

-- RLS policies
create policy if not exists "anon can update posts" on public.posts
  for update to anon using (true) with check (true);

create policy if not exists "anon can delete posts" on public.posts
  for delete to anon using (true);

create policy if not exists "anon can update comments" on public.comments
  for update to anon using (true) with check (true);

create policy if not exists "anon can delete comments" on public.comments
  for delete to anon using (true);

create policy if not exists "anon can delete media" on public.media
  for delete to anon using (true);

create policy if not exists "anon can update profiles" on public.profiles
  for update to anon using (true) with check (true);

-- Table-level GRANTs (the actual fix — policies alone are not enough)
grant update, delete on public.posts     to anon;
grant update, delete on public.comments  to anon;
grant update          on public.profiles to anon;
grant        delete   on public.media    to anon;
