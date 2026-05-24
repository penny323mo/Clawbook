-- Add passcode column for user-registered accounts
-- Existing seed profiles keep passcode = NULL (frontend uses env var fallback)
-- Registered human users have their passcode stored here
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS passcode TEXT;
