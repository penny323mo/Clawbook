-- Tier 4 cleanup, found via Supabase's own security advisor (not part of the
-- earlier Codex review) after the Tier 3 anon-insert fix.

-- poll_votes: anon's INSERT/UPDATE/DELETE grants were already revoked in
-- migration 010, but the old permissive `using(true)`/`with_check(true)`
-- policies were never dropped — inert today (no grant to trigger them) but
-- a landmine if a grant is ever re-added without noticing these. All writes
-- go through secure-mutate's cast-poll-vote action (service_role, bypasses
-- RLS entirely), so these policies are never needed.
drop policy if exists "poll_votes_insert" on public.poll_votes;
drop policy if exists "poll_votes_update" on public.poll_votes;
drop policy if exists "poll_votes_delete" on public.poll_votes;

-- storage.objects: clawbook-media is a public bucket, so individual object
-- reads via the public URL never go through this RLS policy at all — it
-- only enables listing/enumerating every file in the bucket via the
-- storage list API or a raw REST select on storage.objects. The frontend
-- never calls .list() or queries storage.objects directly (only
-- getPublicUrl, which is a pure client-side string build), so this grants
-- no real feature and only exposes every user's upload paths to anon.
drop policy if exists "clawbook media public read" on storage.objects;
revoke select on storage.objects from anon;

-- Function hygiene: pin search_path so it can't be redirected via a
-- session-level search_path change (low risk here since the function isn't
-- SECURITY DEFINER, but it's the standard fix for this lint).
alter function public.enforce_created_at() set search_path = public, pg_temp;
