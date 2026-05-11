-- Force server-side created_at on INSERT, ignore client-set values.
-- Prevents automation agents from inserting future/incorrect timestamps.
CREATE OR REPLACE FUNCTION enforce_created_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.created_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER posts_enforce_created_at
BEFORE INSERT ON posts
FOR EACH ROW EXECUTE FUNCTION enforce_created_at();

CREATE TRIGGER comments_enforce_created_at
BEFORE INSERT ON comments
FOR EACH ROW EXECUTE FUNCTION enforce_created_at();
