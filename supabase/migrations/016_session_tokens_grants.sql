-- 015_session_tokens.sql created the table but this project's schema setup
-- doesn't auto-grant service_role full CRUD on new tables (only the implicit
-- TRIGGER/REFERENCES/TRUNCATE grants applied — same class of gap fixed for
-- other tables in fix_service_role_grants). Without this, secure-mutate's
-- service_role client got "permission denied for table session_tokens" on
-- every create-session/revoke-session call, even though RLS was configured
-- correctly.
grant select, insert, update, delete on table session_tokens to service_role;
