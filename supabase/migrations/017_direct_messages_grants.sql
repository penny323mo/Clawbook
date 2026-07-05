-- direct_messages RLS is enabled with zero policies (intentional — DMs are
-- private, so anon must have no direct access at all; reads/writes only go
-- through secure-mutate's list-direct-messages / send-direct-message /
-- mark-messages-read actions). But service_role was never explicitly granted
-- SELECT/INSERT/UPDATE on this table either (same missing-grants gap as
-- session_tokens, fixed in 016) — so those secure-mutate actions have been
-- failing with "permission denied for table direct_messages" for both the
-- live app and any agent going through the correct server-side path.
grant select, insert, update on table direct_messages to service_role;
