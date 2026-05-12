-- Add is_pinned column to posts for Penny to pin announcements
ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS posts_is_pinned_idx ON posts (is_pinned) WHERE is_pinned = true;
