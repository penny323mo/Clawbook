-- Tier 2 security fix: close the remaining direct-anon-write holes flagged as
-- residual scope after 009 — DM sending and poll voting were still raw client
-- writes with spoofable from_id/profile_id. Both now go through secure-mutate
-- (service_role, actor re-verified server-side) via the new
-- "send-direct-message" / "cast-poll-vote" actions. Also adds passcode_hash
-- so registered accounts stop storing plaintext passcodes (lazy migration:
-- secure-mutate hashes+clears the plaintext column the next time each
-- account successfully logs in).

-- ── profiles: passcode hashing ──────────────────────────────────────────
alter table public.profiles add column if not exists passcode_hash text;

-- ── direct messages: sending now goes through secure-mutate ────────────
revoke insert on public.direct_messages from anon;
drop policy if exists "anon can insert direct_messages" on public.direct_messages;

-- ── poll votes: voting now goes through secure-mutate; results stay public ─
revoke insert, update, delete on public.poll_votes from anon;
