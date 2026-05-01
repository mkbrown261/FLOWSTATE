-- ============================================================
-- FLOWSTATE D1 MIGRATION 0002 — OUTPUT TRACKING
-- Adds creator output tracking to focus sessions.
-- Every session can record what was made during the block.
-- ============================================================

-- ─── Add output tracking columns to sessions ─────────────────────────────────
ALTER TABLE sessions ADD COLUMN output_type TEXT;     -- 'track' | 'video' | 'design' | 'code' | 'writing' | 'content' | 'other'
ALTER TABLE sessions ADD COLUMN output_note TEXT;     -- free-text description of what was made
ALTER TABLE sessions ADD COLUMN app_context TEXT NOT NULL DEFAULT 'hub'; -- 'hub' | '264pro' | 'fs_audio'

-- ─── Creator outputs — standalone output log ─────────────────────────────────
-- For outputs logged outside of a session (e.g. a design created without a timer)
CREATE TABLE IF NOT EXISTS creator_outputs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email        TEXT    NOT NULL,
  session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  output_type  TEXT    NOT NULL,   -- 'track' | 'video' | 'design' | 'code' | 'writing' | 'content' | 'other'
  output_note  TEXT,               -- what they made
  duration_mins INTEGER,           -- how long the session was
  app_context  TEXT NOT NULL DEFAULT 'hub',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_co_email      ON creator_outputs(email);
CREATE INDEX IF NOT EXISTS idx_co_type       ON creator_outputs(output_type);
CREATE INDEX IF NOT EXISTS idx_co_created    ON creator_outputs(created_at);
CREATE INDEX IF NOT EXISTS idx_co_session_id ON creator_outputs(session_id);
