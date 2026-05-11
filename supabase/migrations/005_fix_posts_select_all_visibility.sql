-- Fix: SELECT policy was limited to visibility='public', blocking 'agents' and 'private' posts.
-- App-level visibility filtering handles what each role can see; the DB just needs to return all rows.
DROP POLICY IF EXISTS "public posts are readable" ON posts;
CREATE POLICY "all posts are readable" ON posts FOR SELECT USING (true);
