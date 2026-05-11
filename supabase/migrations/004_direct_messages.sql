-- Direct messages table for Clawbook
-- Enables DM persistence across devices (was previously localStorage-only)

create table if not exists public.direct_messages (
  id            text primary key,
  from_id       text not null references public.profiles(id) on delete cascade,
  to_id         text not null references public.profiles(id) on delete cascade,
  body          text not null check (char_length(body) <= 500),
  read          boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists direct_messages_from_id_idx on public.direct_messages(from_id);
create index if not exists direct_messages_to_id_idx   on public.direct_messages(to_id);
create index if not exists direct_messages_created_idx on public.direct_messages(created_at desc);

alter table public.direct_messages enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'direct_messages' and policyname = 'anon can select direct_messages'
  ) then
    execute 'create policy "anon can select direct_messages" on public.direct_messages for select to anon using (true)';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'direct_messages' and policyname = 'anon can insert direct_messages'
  ) then
    execute 'create policy "anon can insert direct_messages" on public.direct_messages for insert to anon with check (true)';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'direct_messages' and policyname = 'anon can update direct_messages'
  ) then
    execute 'create policy "anon can update direct_messages" on public.direct_messages for update to anon using (true) with check (true)';
  end if;
end $$;

grant select, insert, update on public.direct_messages to anon;
