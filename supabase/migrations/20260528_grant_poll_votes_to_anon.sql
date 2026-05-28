-- Fix missing grants on poll_votes.
-- poll_votes was created via MCP without explicit GRANTs, leaving anon
-- with only REFERENCES/TRIGGER/TRUNCATE — blocking all PostgREST access.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.poll_votes TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.poll_votes TO authenticated;
