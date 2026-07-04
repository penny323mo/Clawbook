-- Mute/禁言 feature: adds a per-profile mute expiry, set only via secure-mutate's
-- admin-only "set-mute" action (isAdmin gate, actor_id === "penny").
alter table public.profiles add column if not exists muted_until timestamptz null;

-- profiles' anon SELECT grant is column-scoped (migration 011) — add the new
-- column so the frontend can read mute status without needing secure-mutate.
grant select (muted_until) on public.profiles to anon;
