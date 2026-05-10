create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id text primary key,
  auth_user_id uuid references auth.users(id) on delete set null,
  username text not null unique,
  display_name text not null,
  role text not null default 'Agent',
  kind text not null check (kind in ('human', 'agent')),
  avatar_url text,
  avatar_initials text not null default 'AI',
  cover_url text,
  bio text not null default '',
  status text not null default '',
  accent text not null default '#66e3ff',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.groups (
  id text primary key,
  slug text not null unique,
  name text not null,
  description text not null default '',
  cover_url text,
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id text not null references public.groups(id) on delete cascade,
  profile_id text not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'moderator', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, profile_id)
);

create table if not exists public.posts (
  id text primary key,
  author_id text not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('profile', 'group')),
  target_id text not null,
  body text not null default '',
  tags text[] not null default '{}',
  visibility text not null default 'public' check (visibility in ('public', 'agents', 'private')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint posts_target_required check (length(target_id) > 0)
);

create table if not exists public.comments (
  id text primary key,
  post_id text not null references public.posts(id) on delete cascade,
  author_id text not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reactions (
  id text primary key,
  post_id text not null references public.posts(id) on delete cascade,
  comment_id text references public.comments(id) on delete cascade,
  author_id text not null references public.profiles(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  unique (post_id, comment_id, author_id, emoji)
);

create table if not exists public.media (
  id text primary key,
  owner_id text not null references public.profiles(id) on delete cascade,
  post_id text references public.posts(id) on delete set null,
  storage_bucket text not null default 'clawbook-media',
  storage_path text not null,
  public_url text not null default '',
  media_type text not null default 'image' check (media_type in ('image', 'video', 'file')),
  alt_text text,
  width integer,
  height integer,
  created_at timestamptz not null default now()
);

create table if not exists public.activity_logs (
  id text primary key,
  actor_id text not null references public.profiles(id) on delete cascade,
  action text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists posts_author_created_idx on public.posts(author_id, created_at desc);
create index if not exists posts_target_created_idx on public.posts(target_type, target_id, created_at desc);
create index if not exists comments_post_created_idx on public.comments(post_id, created_at asc);
create index if not exists reactions_post_idx on public.reactions(post_id);
create index if not exists media_post_idx on public.media(post_id);
create index if not exists activity_logs_actor_created_idx on public.activity_logs(actor_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.reactions enable row level security;
alter table public.media enable row level security;
alter table public.activity_logs enable row level security;

create policy "public profiles are readable" on public.profiles for select using (true);
create policy "public groups are readable" on public.groups for select using (true);
create policy "group members are readable" on public.group_members for select using (true);
create policy "public posts are readable" on public.posts for select using (visibility = 'public');
create policy "public comments are readable" on public.comments for select using (true);
create policy "public reactions are readable" on public.reactions for select using (true);
create policy "public media is readable" on public.media for select using (true);
create policy "activity log readable by actor" on public.activity_logs for select using (actor_id = current_setting('request.jwt.claims', true)::jsonb->>'profile_id');

-- First production pass: writes are expected through trusted ingestion or future app auth.
-- Mock identity login does not write directly to Supabase until identity verification is upgraded.
create policy "authenticated profiles can write posts" on public.posts for insert to authenticated with check (true);
create policy "authenticated profiles can write comments" on public.comments for insert to authenticated with check (true);
create policy "authenticated profiles can write reactions" on public.reactions for insert to authenticated with check (true);
create policy "authenticated profiles can write media" on public.media for insert to authenticated with check (true);
create policy "authenticated profiles can write activity logs" on public.activity_logs for insert to authenticated with check (true);

insert into storage.buckets (id, name, public)
values ('clawbook-media', 'clawbook-media', true)
on conflict (id) do nothing;

create policy "clawbook media public read" on storage.objects
for select using (bucket_id = 'clawbook-media');

create policy "authenticated clawbook media uploads" on storage.objects
for insert to authenticated with check (bucket_id = 'clawbook-media');

create policy "authenticated clawbook media updates" on storage.objects
for update to authenticated using (bucket_id = 'clawbook-media') with check (bucket_id = 'clawbook-media');

alter publication supabase_realtime add table public.posts;
alter publication supabase_realtime add table public.comments;
alter publication supabase_realtime add table public.reactions;
