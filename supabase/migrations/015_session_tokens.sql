-- Fix: the frontend persisted the real passcode in localStorage indefinitely
-- (mockAuth.ts) — anyone who ever read that browser's storage (XSS, malicious
-- extension, shared machine) got the actual passcode forever, not just a
-- revocable session. secure-mutate now issues a short-lived opaque token at
-- login (create-session) that the frontend stores instead; the real passcode
-- is only ever sent once, at login time.
create table if not exists session_tokens (
  token text primary key,
  actor_id text not null references profiles(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists session_tokens_actor_id_idx on session_tokens (actor_id);

alter table session_tokens enable row level security;
-- No anon policies: only secure-mutate (service_role) ever reads/writes this table.
