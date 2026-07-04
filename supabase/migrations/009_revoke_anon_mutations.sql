-- Tier 1 security fix: close the anon-role write/delete/read holes opened by
-- 002/003/004. Every mutation these policies used to allow directly from the
-- browser (post/comment update+delete, profile update, reaction delete, DM
-- listing+read-receipts) is now handled by the secure-mutate Edge Function,
-- which re-verifies the caller's passcode server-side and enforces row
-- ownership before touching data with the service_role key. anon no longer
-- needs (or should have) direct UPDATE/DELETE on these tables.
--
-- Left untouched on purpose (still direct anon writes, unchanged by this
-- migration, tracked separately): posts/comments/reactions/media INSERT,
-- direct_messages INSERT, poll_votes, profiles.passcode column exposure
-- (registration/delete already gated by ADMIN_CODE via user-admin function).

-- ── posts ────────────────────────────────────────────────────────────────
revoke update, delete on public.posts from anon;
drop policy if exists "anon can update posts" on public.posts;
drop policy if exists "anon can delete posts" on public.posts;

-- ── comments ─────────────────────────────────────────────────────────────
revoke update, delete on public.comments from anon;
drop policy if exists "anon can update comments" on public.comments;
drop policy if exists "anon can delete comments" on public.comments;

-- ── reactions ────────────────────────────────────────────────────────────
drop policy if exists "anon can delete reactions" on public.reactions;

-- ── media ────────────────────────────────────────────────────────────────
revoke delete on public.media from anon;
drop policy if exists "anon can delete media" on public.media;

-- ── profiles ─────────────────────────────────────────────────────────────
revoke update on public.profiles from anon;
drop policy if exists "anon can update profiles" on public.profiles;

-- ── direct messages ──────────────────────────────────────────────────────
-- Listing/reading someone else's inbox and marking-read now go through
-- secure-mutate (service_role). anon keeps INSERT only (sending is still a
-- direct client write, unchanged by this migration).
revoke select, update on public.direct_messages from anon;
drop policy if exists "anon can select direct_messages" on public.direct_messages;
drop policy if exists "anon can update direct_messages" on public.direct_messages;
