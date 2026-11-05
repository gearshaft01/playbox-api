ALTER TABLE games
ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
CHECK (visibility IN ('public', 'private'));

CREATE INDEX IF NOT EXISTS games_visibility_idx ON games (visibility);
