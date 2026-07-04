-- Tier 3 security fix: close the last direct-anon-INSERT paths (posts,
-- comments, reactions, media, activity_logs, storage uploads) that let
-- anyone impersonate any author_id/owner_id via the raw Supabase REST API,
-- and stop anon from ever reading profiles.passcode / passcode_hash at the
-- column level (defense-in-depth: the frontend never SELECTs those columns,
-- but a raw REST call could until now).
--
-- Creating posts/comments/reactions and uploading media now go through
-- secure-mutate's "create-post" / "create-comment" / "add-reaction" /
-- "create-upload-url" actions (service_role, actor re-verified server-side).

-- ── posts / comments / reactions / media / activity_logs insert ─────────
revoke insert on public.posts from anon;
revoke insert on public.comments from anon;
revoke insert on public.reactions from anon;
revoke insert on public.media from anon;
revoke insert on public.activity_logs from anon;

drop policy if exists "anon can write posts" on public.posts;
drop policy if exists "anon can write comments" on public.comments;
drop policy if exists "anon can write reactions" on public.reactions;
drop policy if exists "anon can write media" on public.media;
drop policy if exists "anon can write activity logs" on public.activity_logs;

-- ── storage: uploads now go through signed URLs minted by secure-mutate ──
-- (signed-upload tokens are authorized independently of anon's own RLS
-- policies, so revoking these does not break create-upload-url uploads)
revoke insert, update on storage.objects from anon;
drop policy if exists "anon clawbook media uploads" on storage.objects;
drop policy if exists "anon clawbook media updates" on storage.objects;

-- ── profiles: never expose passcode / passcode_hash columns to anon ─────
revoke select on public.profiles from anon;
grant select (
  id, username, display_name, kind, role, avatar_url, avatar_initials,
  cover_url, bio, status, accent, is_active, created_at, updated_at
) on public.profiles to anon;
