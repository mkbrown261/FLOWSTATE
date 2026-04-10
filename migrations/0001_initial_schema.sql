-- ============================================================
-- FLOWSTATE D1 MIGRATION 0001 — INITIAL SCHEMA
-- Covers: FLOWSTATE Hub, 264 Pro Video Editor, FlowState Audio
-- This is the PERMANENT source of truth.
-- Redis is the FAST CACHE. D1 is the RECORD OF TRUTH.
-- ============================================================

-- ─── USERS ───────────────────────────────────────────────────────────────────
-- One row per authenticated user (Google OAuth)
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT    UNIQUE NOT NULL,
  name           TEXT    NOT NULL DEFAULT '',
  picture        TEXT    NOT NULL DEFAULT '',
  provider       TEXT    NOT NULL DEFAULT 'google',      -- 'google' | 'magic_link'
  tier           TEXT    NOT NULL DEFAULT 'free',        -- 'free' | 'pro' | 'team' | 'clawflow' | 'enterprise'
  stripe_customer_id TEXT UNIQUE,
  coin_balance   INTEGER NOT NULL DEFAULT 0,             -- ClawFlow monthly coin allowance
  coin_reset_at  TEXT,                                   -- ISO datetime of next coin reset
  onboarding_completed INTEGER NOT NULL DEFAULT 0,       -- 0 | 1
  onboarding_data TEXT,                                  -- JSON blob from /api/onboarding/complete
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_stripe ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_tier   ON users(tier);

-- ─── SUBSCRIPTIONS ───────────────────────────────────────────────────────────
-- One active row per user. Updated by Stripe webhooks.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email                 TEXT    NOT NULL,                -- denormalised for fast lookup by email
  stripe_subscription_id TEXT   UNIQUE,
  stripe_price_id       TEXT,
  plan                  TEXT    NOT NULL DEFAULT 'free', -- 'free' | 'pro' | 'team' | 'clawflow'
  billing_interval      TEXT,                           -- 'month' | 'year'
  status                TEXT    NOT NULL DEFAULT 'active', -- 'active' | 'canceled' | 'past_due' | 'trialing'
  current_period_start  TEXT,
  current_period_end    TEXT,
  cancel_at_period_end  INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subs_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_email   ON subscriptions(email);
CREATE INDEX IF NOT EXISTS idx_subs_stripe  ON subscriptions(stripe_subscription_id);

-- ─── TRANSACTIONS ─────────────────────────────────────────────────────────────
-- Immutable billing event log. Never deleted.
CREATE TABLE IF NOT EXISTS transactions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email            TEXT    NOT NULL,
  stripe_event_id  TEXT    UNIQUE NOT NULL,              -- idempotency key
  stripe_invoice_id TEXT,
  amount_cents     INTEGER NOT NULL DEFAULT 0,
  currency         TEXT    NOT NULL DEFAULT 'usd',
  type             TEXT    NOT NULL,                     -- 'subscription_created' | 'subscription_renewed' | 'token_pack' | 'refund'
  plan             TEXT,
  token_pack_size  INTEGER,                              -- for token pack purchases
  status           TEXT    NOT NULL DEFAULT 'succeeded', -- 'succeeded' | 'failed' | 'refunded'
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_email          ON transactions(email);
CREATE INDEX IF NOT EXISTS idx_tx_stripe_event   ON transactions(stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_tx_user_id        ON transactions(user_id);

-- ─── DESKTOP TOKENS ──────────────────────────────────────────────────────────
-- Tokens issued to Electron desktop apps (264 Pro, FlowState Audio).
-- Verified server-side on every AI tool call.
CREATE TABLE IF NOT EXISTS desktop_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT    UNIQUE NOT NULL,                    -- SHA-256 of the raw token
  email      TEXT    NOT NULL,
  app        TEXT    NOT NULL,                           -- '264pro' | 'fs_audio'
  tier       TEXT    NOT NULL DEFAULT 'free',            -- snapshot of tier at issue time
  issued_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,                           -- 90 days from issued_at
  revoked    INTEGER NOT NULL DEFAULT 0,                 -- 0 | 1
  last_used  TEXT
);

CREATE INDEX IF NOT EXISTS idx_dt_token_hash ON desktop_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_dt_email      ON desktop_tokens(email);
CREATE INDEX IF NOT EXISTS idx_dt_app        ON desktop_tokens(app);

-- ─── TOKEN PACKS ─────────────────────────────────────────────────────────────
-- Purchased one-time token top-ups. Used by checkAntiAbuse overflow logic.
CREATE TABLE IF NOT EXISTS token_packs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email        TEXT    NOT NULL,
  tokens       INTEGER NOT NULL,                         -- 50000 | 200000 | 500000
  tokens_used  INTEGER NOT NULL DEFAULT 0,
  stripe_event_id TEXT UNIQUE NOT NULL,
  purchased_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tp_email ON token_packs(email);

-- ─── COIN LEDGER ─────────────────────────────────────────────────────────────
-- Immutable record of every ClawBot/ClawFlow coin spend.
CREATE TABLE IF NOT EXISTS coin_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email       TEXT    NOT NULL,
  action      TEXT    NOT NULL,                          -- 'chat_message' | 'walkthrough_generation' | 'ai_upscale' | 'stem_separation' | 'ai_master' etc.
  cost        INTEGER NOT NULL,                          -- coins deducted
  app_context TEXT    NOT NULL DEFAULT 'hub',            -- 'hub' | '264pro' | 'fs_audio'
  balance_after INTEGER,                                 -- coins remaining after deduction
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cl_email ON coin_ledger(email);
CREATE INDEX IF NOT EXISTS idx_cl_app   ON coin_ledger(app_context);

-- ─── 264 PRO — PROJECT METADATA ───────────────────────────────────────────────
-- Metadata only. The actual .264proj JSON is stored in R2.
CREATE TABLE IF NOT EXISTS projects_264pro (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT    NOT NULL,
  name          TEXT    NOT NULL DEFAULT 'Untitled Project',
  r2_key        TEXT    NOT NULL UNIQUE,                 -- R2 object key e.g. "264pro/{email}/projects/{uuid}.264proj"
  duration_secs REAL,
  resolution    TEXT,                                    -- '1920x1080' | '3840x2160' etc.
  fps           REAL,
  size_bytes    INTEGER,
  thumbnail_r2_key TEXT,                                 -- R2 key for thumbnail image
  last_opened   TEXT,
  version       TEXT,                                    -- project schema version
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_264p_user_id ON projects_264pro(user_id);
CREATE INDEX IF NOT EXISTS idx_264p_email   ON projects_264pro(email);

-- ─── 264 PRO — AI OUTPUTS ─────────────────────────────────────────────────────
-- Tracks every AI-generated asset (upscale, slow-mo, denoise, enhance).
-- The file lives in R2. This row ensures it's never orphaned.
CREATE TABLE IF NOT EXISTS ai_outputs_264pro (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL,
  project_id  INTEGER REFERENCES projects_264pro(id) ON DELETE SET NULL,
  tool        TEXT    NOT NULL,                          -- 'upscale' | 'slow_mo' | 'denoise' | 'face_enhance' | 'color_grade'
  r2_key      TEXT    NOT NULL UNIQUE,                   -- R2 object key
  source_url  TEXT,                                      -- original Replicate/API URL before R2 save
  size_bytes  INTEGER,
  duration_secs REAL,
  params      TEXT,                                      -- JSON of tool parameters used
  coins_spent INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_aio_email ON ai_outputs_264pro(email);
CREATE INDEX IF NOT EXISTS idx_aio_project ON ai_outputs_264pro(project_id);

-- ─── FLOWSTATE AUDIO — PROJECT METADATA ──────────────────────────────────────
-- Metadata only. The actual .fsa project JSON is stored in R2.
CREATE TABLE IF NOT EXISTS projects_audio (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT    NOT NULL,
  name          TEXT    NOT NULL DEFAULT 'Untitled Project',
  r2_key        TEXT    NOT NULL UNIQUE,                 -- R2 object key e.g. "audio/{email}/projects/{uuid}.fsa"
  bpm           REAL,
  key           TEXT,                                    -- musical key e.g. 'C Major'
  track_count   INTEGER,
  duration_secs REAL,
  size_bytes    INTEGER,
  last_opened   TEXT,
  version       TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ap_user_id ON projects_audio(user_id);
CREATE INDEX IF NOT EXISTS idx_ap_email   ON projects_audio(email);

-- ─── FLOWSTATE AUDIO — AI OUTPUTS ────────────────────────────────────────────
-- Stems, masters, generated tracks, arrangement suggestions.
CREATE TABLE IF NOT EXISTS ai_outputs_audio (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL,
  project_id  INTEGER REFERENCES projects_audio(id) ON DELETE SET NULL,
  tool        TEXT    NOT NULL,                          -- 'stem_separation' | 'ai_master' | 'music_gen' | 'beat_gen' | 'arrangement'
  r2_key      TEXT    NOT NULL UNIQUE,
  source_url  TEXT,
  file_name   TEXT,
  size_bytes  INTEGER,
  duration_secs REAL,
  params      TEXT,                                      -- JSON
  coins_spent INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_aoa_email   ON ai_outputs_audio(email);
CREATE INDEX IF NOT EXISTS idx_aoa_project ON ai_outputs_audio(project_id);

-- ─── FLOWSTATE AUDIO — EXPORTED FILES ────────────────────────────────────────
-- Final bounced WAV/MP3/AIFF exports stored in R2.
CREATE TABLE IF NOT EXISTS exports_audio (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL,
  project_id  INTEGER REFERENCES projects_audio(id) ON DELETE SET NULL,
  format      TEXT    NOT NULL,                          -- 'wav' | 'mp3' | 'aiff'
  bit_depth   INTEGER,                                   -- 16 | 24 | 32
  sample_rate INTEGER,                                   -- 44100 | 48000 | 96000
  is_stems    INTEGER NOT NULL DEFAULT 0,                -- 0=full mix, 1=stem export
  r2_key      TEXT    NOT NULL UNIQUE,
  size_bytes  INTEGER,
  duration_secs REAL,
  lufs        REAL,                                      -- measured LUFS after normalisation
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ea_email   ON exports_audio(email);
CREATE INDEX IF NOT EXISTS idx_ea_project ON exports_audio(project_id);

-- ─── HUB — USER TASKS (Kanban) ───────────────────────────────────────────────
-- Replaces cookie-based task storage. Persists across devices.
CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'todo',            -- 'todo' | 'inprogress' | 'done'
  priority   TEXT,                                       -- 'low' | 'medium' | 'high' | 'critical'
  tags       TEXT,                                       -- JSON array
  position   INTEGER NOT NULL DEFAULT 0,                 -- sort order within status column
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_email  ON tasks(email);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- ─── HUB — SESSION HISTORY ───────────────────────────────────────────────────
-- Pomodoro focus session history. Powers streaks, FlowScore, metrics.
CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email           TEXT    NOT NULL,
  phase           TEXT    NOT NULL,                      -- 'focus' | 'short_break' | 'long_break'
  duration_mins   INTEGER NOT NULL,
  completed       INTEGER NOT NULL DEFAULT 1,            -- 0=abandoned 1=completed
  context         TEXT,                                  -- 'code' | 'writing' | 'design' etc.
  focus_score     INTEGER,                               -- FlowScore 0-100
  session_date    TEXT    NOT NULL,                      -- YYYY-MM-DD for streak grouping
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email);
CREATE INDEX IF NOT EXISTS idx_sessions_date  ON sessions(session_date);
