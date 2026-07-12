-- ══════════════════════════════════════════════════════════════════
--  Mar Thoma SS Samajam — Supabase BACKUP Schema (Frontend-Direct)
--  Run this once in: Supabase Dashboard → SQL Editor → New Query
--
--  This is used as an EXTRA BACKUP COPY only — Firebase stays the
--  primary live-synced database. Your browser pushes a copy of every
--  save here too, using the safe "anon" public key (never the secret
--  service_role key, which should never go in browser code).
-- ══════════════════════════════════════════════════════════════════

-- ── Tables (one per collection, JSONB storage — mirrors local data 1:1) ──
CREATE TABLE IF NOT EXISTS mt_cand (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS mt_hm   (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS mt_sch  (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS mt_cen  (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS mt_dio  (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS mt_dist (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS mt_ec   (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT now());

-- ── Row Level Security ────────────────────────────────────────────
-- Since the browser uses the public "anon" key (safe to expose, unlike
-- service_role), access is controlled entirely by these policies —
-- anonymous sign-in required (same idea as the Firebase Anonymous
-- Authentication step), matching "must go through the real app" access.
ALTER TABLE mt_cand ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_hm   ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_sch  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_cen  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_dio  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_dist ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_ec   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_cand" ON mt_cand FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_hm"   ON mt_hm   FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_sch"  ON mt_sch  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_cen"  ON mt_cen  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_dio"  ON mt_dio  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_dist" ON mt_dist FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_ec"   ON mt_ec   FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════════
--  After running this:
--  1. Authentication → Sign In / Providers → make sure "Anonymous
--     Sign-ins" is enabled (Authentication → Sign In / Up → Anonymous).
--  2. Project Settings → API → copy the "Project URL" and the
--     "anon public" key (NOT service_role — never use that one here).
--  3. In the app → Settings → Supabase Backup → paste both → Connect.
-- ══════════════════════════════════════════════════════════════════
