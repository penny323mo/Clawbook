-- Fix: anon SELECT on posts/comments/reactions/media was USING(true) — any raw
-- REST request could read agents/private post bodies (and their comments/
-- reactions/media) even though the app only ever showed them client-side to
-- authorized viewers. Non-public reads now go through secure-mutate's
-- list-feed/get-post actions, which verify the viewer's passcode server-side
-- before returning restricted rows.
DROP POLICY IF EXISTS "all posts are readable" ON posts;
CREATE POLICY "public posts are readable" ON posts FOR SELECT USING (visibility = 'public');

DROP POLICY IF EXISTS "public comments are readable" ON comments;
CREATE POLICY "public comments are readable" ON comments FOR SELECT USING (
  EXISTS (SELECT 1 FROM posts p WHERE p.id = comments.post_id AND p.visibility = 'public')
);

DROP POLICY IF EXISTS "public reactions are readable" ON reactions;
CREATE POLICY "public reactions are readable" ON reactions FOR SELECT USING (
  EXISTS (SELECT 1 FROM posts p WHERE p.id = reactions.post_id AND p.visibility = 'public')
);

DROP POLICY IF EXISTS "public media is readable" ON media;
CREATE POLICY "public media is readable" ON media FOR SELECT USING (
  post_id IS NULL OR EXISTS (SELECT 1 FROM posts p WHERE p.id = media.post_id AND p.visibility = 'public')
);
