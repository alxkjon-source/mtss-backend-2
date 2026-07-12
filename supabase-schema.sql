-- ══════════════════════════════════════════════════════════════════
--  Mar Thoma SS Samajam — Supabase Schema
--  Run this once in: Supabase Dashboard → SQL Editor → New Query
-- ══════════════════════════════════════════════════════════════════

-- ── Tables (one per collection, JSONB storage) ────────────────────
CREATE TABLE IF NOT EXISTS mt_cand  (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS mt_hm    (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS mt_users (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS mt_dios  (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS mt_cens  (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS mt_dist  (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS mt_ec    (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS mt_cls   (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS mt_audit (id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');

-- ── Indexes for common query fields inside JSONB ──────────────────
CREATE INDEX IF NOT EXISTS idx_cand_sch  ON mt_cand  ((data->>'schId'));
CREATE INDEX IF NOT EXISTS idx_cand_yr   ON mt_cand  ((data->>'yr'));
CREATE INDEX IF NOT EXISTS idx_hm_sch    ON mt_hm    ((data->>'schId'));

-- ── Row Level Security (RLS) ──────────────────────────────────────
-- The backend uses the SERVICE ROLE key which bypasses RLS.
-- Enable RLS here as a safety net for any accidental public access.
ALTER TABLE mt_cand  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_hm    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_dios  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_cens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_dist  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_ec    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_cls   ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt_audit ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically — no policy needed for it.
-- If you also want direct anon access (not recommended), add:
-- CREATE POLICY "anon_read" ON mt_cand FOR SELECT USING (true);

-- ── Enable Realtime for all tables ────────────────────────────────
-- This lets the backend receive live change events from Supabase.
ALTER PUBLICATION supabase_realtime ADD TABLE
  mt_cand, mt_hm, mt_users, mt_dios, mt_cens, mt_dist, mt_ec, mt_cls, mt_audit;

-- ══════════════════════════════════════════════════════════════════
--  Done! Now go to Settings → MTSS Backend → Supabase and enter:
--    URL : https://<project-ref>.supabase.co
--    Key : your service_role key  (Project Settings → API)
-- ══════════════════════════════════════════════════════════════════
