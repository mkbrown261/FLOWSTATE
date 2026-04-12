-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0003: Referral system + Public FlowScore profiles
-- ──────────────────────────────────────────────────────────────────────────────

-- Referral codes table
-- Each user gets one code; tracks who used it and whether bonuses were granted
CREATE TABLE IF NOT EXISTS referrals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT    UNIQUE NOT NULL,              -- e.g. FS-A1B2C3
  referrer_email TEXT    NOT NULL,
  referrer_name  TEXT    NOT NULL DEFAULT '',
  used_by_email  TEXT,                                 -- NULL until claimed
  used_at        TEXT,                                 -- ISO datetime
  bonus_granted  INTEGER NOT NULL DEFAULT 0,           -- 1 once tokens credited
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_referrals_code           ON referrals(code);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_email ON referrals(referrer_email);
CREATE INDEX IF NOT EXISTS idx_referrals_used_by        ON referrals(used_by_email);

-- Public FlowScore profiles
-- Users opt in to a public profile page at /u/:slug
-- Columns match exactly what /api/profile/setup inserts
CREATE TABLE IF NOT EXISTS public_profiles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,                                -- FK to users.id (optional)
  email        TEXT    UNIQUE NOT NULL,
  slug         TEXT    UNIQUE NOT NULL,                -- URL-safe handle, e.g. "mkbrown"
  display_name TEXT    NOT NULL DEFAULT '',
  tagline      TEXT    NOT NULL DEFAULT '',
  avatar_url   TEXT    NOT NULL DEFAULT '',
  show_score   INTEGER NOT NULL DEFAULT 1,             -- show FlowScore publicly
  show_streak  INTEGER NOT NULL DEFAULT 1,             -- show streak publicly
  show_outputs INTEGER NOT NULL DEFAULT 0,             -- show output breakdown publicly
  show_weekly  INTEGER NOT NULL DEFAULT 0,             -- show weekly stats publicly
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_public_profiles_slug    ON public_profiles(slug);
CREATE INDEX IF NOT EXISTS idx_public_profiles_email   ON public_profiles(email);
CREATE INDEX IF NOT EXISTS idx_public_profiles_user_id ON public_profiles(user_id);
