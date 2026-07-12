/**
 * Mar Thoma SS Samajam — Realtime Backend Server  v3
 * ─────────────────────────────────────────────────────
 * Storage layers (all optional, all independent):
 *   Primary  : data/db.json          — always-on local store
 *   Mirror A : Firebase REST API     — configured via Settings UI
 *   Mirror B : Supabase              — configured via Settings UI
 *
 * Realtime : WebSocket push to browsers  +  Supabase postgres_changes listener
 *
 * Firebase needs no SDK — uses REST API + Database URL.
 * Supabase uses @supabase/supabase-js v2 (npm install will fetch it).
 */

'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');

// ── paths ─────────────────────────────────────────────────────────
const PORT     = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');
const FB_CFG   = path.join(DATA_DIR, 'firebase.json');
const SB_CFG   = path.join(DATA_DIR, 'supabase.json');

// ── collections ───────────────────────────────────────────────────
const COLLECTIONS = [
  'mt_cand','mt_hm','mt_users','mt_dios','mt_cens',
  'mt_dist','mt_ec','mt_cls','mt_audit'
];

// ══════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function readJSON(file, def = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}

// ══════════════════════════════════════════════════════════════════
//  SECURITY — API key required for every write / sensitive operation
// ─────────────────────────────────────────────────────────────────
//  Nothing on the internet is "unbreakable" — but without this, the
//  backend had NO authentication at all: anyone who knew the URL could
//  read, edit, or permanently delete every candidate's data, or hijack
//  the Firebase/Supabase/S3 connections. This closes that gap.
//
//  Set API_KEY as an environment variable on your host for a key you
//  control. If you don't set one, the server generates a strong random
//  key on first boot, saves it to data/security.json so it survives
//  restarts, and prints it ONCE in the startup log — copy it from there
//  into the app's Settings page (only give it to admin / trusted staff).
// ══════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const SEC_FILE = path.join(DATA_DIR, 'security.json');
function loadOrCreateApiKey() {
  if (process.env.API_KEY) return { key: process.env.API_KEY, source: 'environment variable' };
  ensureDir();
  const existing = readJSON(SEC_FILE, {});
  if (existing.apiKey) return { key: existing.apiKey, source: 'saved on disk (data/security.json)' };
  const generated = crypto.randomBytes(24).toString('hex');
  writeJSON(SEC_FILE, { apiKey: generated, createdAt: new Date().toISOString() });
  return { key: generated, source: 'auto-generated just now' };
}
const API_KEY_INFO = loadOrCreateApiKey();
const API_KEY = API_KEY_INFO.key;

// Basic brute-force slowdown: after 10 wrong attempts from one IP within
// 10 minutes, that IP is locked out for 10 minutes.
const _failedAuth = new Map(); // ip -> { count, firstAt }
function requireApiKey(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const rec = _failedAuth.get(ip);
  const now = Date.now();
  if (rec && rec.count >= 10 && now - rec.firstAt < 10 * 60 * 1000) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
  }
  const supplied = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const ok = supplied && supplied.length === API_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(API_KEY));
  if (!ok) {
    if (!rec || now - rec.firstAt > 10 * 60 * 1000) _failedAuth.set(ip, { count: 1, firstAt: now });
    else rec.count++;
    return res.status(401).json({ error: 'Missing or invalid API key. This action requires the backend security key from Settings.' });
  }
  _failedAuth.delete(ip);
  next();
}
function writeJSON(file, data) {
  ensureDir(); fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ══════════════════════════════════════════════════════════════════
//  Local JSON database
// ══════════════════════════════════════════════════════════════════
let DB = readJSON(DB_FILE);
COLLECTIONS.forEach(c => { if (!DB[c]) DB[c] = {}; });
function saveDB() { writeJSON(DB_FILE, DB); }

// ══════════════════════════════════════════════════════════════════
//  Firebase REST layer  (no Admin SDK — works with open rules)
// ══════════════════════════════════════════════════════════════════
let FB = { url: '', enabled: false, secret: '' };

function loadFBConfig() {
  const c = readJSON(FB_CFG);
  FB = { url: (c.url || '').replace(/\/$/, ''), enabled: !!c.enabled, secret: c.secret || '' };
}
loadFBConfig();

const fbUrl  = p => FB.secret ? `${FB.url}/${p}.json?auth=${FB.secret}` : `${FB.url}/${p}.json`;
const fbFetch = (p, opts) => fetch(fbUrl(p), opts).catch(e => console.warn('[FB]', e.message));

async function fbSet(col, id, rec)  { if (FB.enabled && FB.url) await fbFetch(`${col}/${id}`, { method:'PUT',  headers:{'Content-Type':'application/json'}, body:JSON.stringify(rec) }); }
async function fbDel(col, id)       { if (FB.enabled && FB.url) await fbFetch(`${col}/${id}`, { method:'DELETE' }); }
async function fbBulk(col, records) {
  if (!FB.enabled || !FB.url || !records.length) return;
  const obj = {}; records.forEach(r => { if (r?.id) obj[r.id] = r; });
  await fbFetch(col, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(obj) });
}
async function fbPushAll() {
  let n = 0;
  for (const col of COLLECTIONS) { const r = Object.values(DB[col]); if (r.length) { await fbBulk(col, r); n += r.length; } }
  return n;
}
async function fbPullAll() {
  let n = 0;
  for (const col of COLLECTIONS) {
    try {
      const res = await fetch(fbUrl(col));
      const data = await res.json();
      if (data && typeof data === 'object' && !data.error) {
        Object.values(data).forEach(r => { if (r?.id) { DB[col][r.id] = r; n++; } });
      }
    } catch(e) { console.warn('[FB] pull', col, e.message); }
  }
  saveDB(); return n;
}
async function fbTest() {
  if (!FB.url) return { ok: false, message: 'No database URL configured' };
  try {
    const r = await fetch(fbUrl('_ping'), { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ ts: Date.now() }) });
    if (r.ok) { await fetch(fbUrl('_ping'), { method:'DELETE' }).catch(() => {}); return { ok:true, message:'Firebase connection successful ✅' }; }
    return { ok:false, message:`HTTP ${r.status}: ${await r.text()}` };
  } catch(e) { return { ok:false, message:`Network error: ${e.message}` }; }
}

// ══════════════════════════════════════════════════════════════════
//  Supabase layer  (@supabase/supabase-js v2)
// ══════════════════════════════════════════════════════════════════
let SB = { url: '', key: '', enabled: false };
let sbClient = null;

function loadSBConfig() {
  const c = readJSON(SB_CFG);
  SB = { url: (c.url || '').replace(/\/$/, ''), key: c.key || '', enabled: !!c.enabled };
  if (SB.enabled && SB.url && SB.key) initSupabase();
}

function initSupabase(url = SB.url, key = SB.key) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    sbClient = createClient(url, key, { auth: { persistSession: false } });
    console.log(`[SB] Supabase client ready → ${url}`);
    _sbSubscribeRealtime();
    return true;
  } catch(e) {
    console.warn('[SB] Init failed:', e.message);
    sbClient = null; return false;
  }
}

/** Subscribe to Postgres realtime changes — push to WebSocket clients */
function _sbSubscribeRealtime() {
  if (!sbClient) return;
  COLLECTIONS.forEach(col => {
    sbClient.channel(`rt-${col}`)
      .on('postgres_changes', { event:'*', schema:'public', table: col }, payload => {
        const { eventType, new: n, old: o } = payload;
        if (eventType === 'DELETE') {
          const id = o?.id; if (!id) return;
          delete DB[col][id]; saveDB();
          broadcast(col, { op:'del', id });
        } else {
          // n.data holds the JSONB blob
          const record = n?.data ? { ...n.data, id: n.id } : n;
          if (!record?.id) return;
          DB[col][record.id] = record; saveDB();
          broadcast(col, { op:'set', id: record.id, record });
        }
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') console.log(`[SB] Realtime subscribed: ${col}`);
      });
  });
}

// Supabase rows: { id TEXT PK, data JSONB }
const sbRow    = (id, rec) => ({ id, data: rec });
const sbUnwrap = row => row?.data ? { ...row.data, id: row.id } : row;

async function sbSet(col, id, rec) {
  if (!SB.enabled || !sbClient) return;
  const { error } = await sbClient.from(col).upsert(sbRow(id, rec), { onConflict:'id' });
  if (error) console.warn('[SB] set:', error.message);
}
async function sbDel(col, id) {
  if (!SB.enabled || !sbClient) return;
  const { error } = await sbClient.from(col).delete().eq('id', id);
  if (error) console.warn('[SB] del:', error.message);
}
async function sbBulk(col, records) {
  if (!SB.enabled || !sbClient || !records.length) return;
  const rows = records.filter(r => r?.id).map(r => sbRow(r.id, r));
  const { error } = await sbClient.from(col).upsert(rows, { onConflict:'id' });
  if (error) console.warn('[SB] bulk:', error.message);
}
async function sbPushAll() {
  let n = 0;
  for (const col of COLLECTIONS) { const r = Object.values(DB[col]); if (r.length) { await sbBulk(col, r); n += r.length; } }
  return n;
}
async function sbPullAll() {
  let n = 0;
  for (const col of COLLECTIONS) {
    const { data, error } = await sbClient.from(col).select('*');
    if (error) { console.warn('[SB] pull', col, error.message); continue; }
    (data || []).forEach(row => { const r = sbUnwrap(row); if (r?.id) { DB[col][r.id] = r; n++; } });
  }
  saveDB(); return n;
}
async function sbTest() {
  if (!SB.url || !SB.key) return { ok:false, message:'No Supabase URL or key set' };
  try {
    const { createClient } = require('@supabase/supabase-js');
    const client = createClient(SB.url, SB.key, { auth:{ persistSession:false } });
    const { error } = await client.from(COLLECTIONS[0]).select('count').limit(1);
    if (error?.code === '42P01') return { ok:false, message:'Tables not found — run the SQL schema in Supabase first.' };
    if (error)  return { ok:false, message:`Supabase error: ${error.message}` };
    return { ok:true, message:'Supabase connection successful ✅' };
  } catch(e) { return { ok:false, message:`Error: ${e.message}` }; }
}
loadSBConfig();  // init on startup if already configured

// ══════════════════════════════════════════════════════════════════
//  S3 (or S3-compatible) backup layer — feeds Synology Cloud Sync / Hyper Backup
// ─────────────────────────────────────────────────────────────────
//  Works with real AWS S3, or any S3-compatible free-tier bucket
//  (Cloudflare R2, Backblaze B2, Wasabi, MinIO, etc).
//  Configure via environment variables (set them in your host's dashboard):
//    S3_BUCKET               (required to enable)
//    S3_REGION               (default: us-east-1)
//    S3_ACCESS_KEY_ID        (required to enable)
//    S3_SECRET_ACCESS_KEY    (required to enable)
//    S3_ENDPOINT             (optional — for non-AWS S3-compatible providers)
//    S3_BACKUP_PREFIX        (default: mtss/)
//    S3_BACKUP_INTERVAL_MIN  (default: 30)
//
//  Point Synology Cloud Sync / Hyper Backup at the same bucket
//  (download-only / one-way sync) to keep a NAS copy automatically.
// ══════════════════════════════════════════════════════════════════
const S3_CFG_FILE = path.join(DATA_DIR, 's3.json');

function loadS3Config() {
  const fileCfg = readJSON(S3_CFG_FILE, {});
  return {
    bucket:    process.env.S3_BUCKET            || fileCfg.bucket    || '',
    region:    process.env.S3_REGION            || fileCfg.region    || 'us-east-1',
    accessKey: process.env.S3_ACCESS_KEY_ID      || fileCfg.accessKey || '',
    secretKey: process.env.S3_SECRET_ACCESS_KEY  || fileCfg.secretKey || '',
    endpoint:  process.env.S3_ENDPOINT           || fileCfg.endpoint  || '',
    prefix:    (process.env.S3_BACKUP_PREFIX     || fileCfg.prefix    || 'mtss/').replace(/^\/+/, '').replace(/\/*$/, '/'),
    intervalMin: +(process.env.S3_BACKUP_INTERVAL_MIN || fileCfg.intervalMin || 30),
  };
}
let S3CFG = loadS3Config();
let s3Client = null;

function initS3() {
  if (!S3CFG.bucket || !S3CFG.accessKey || !S3CFG.secretKey) { s3Client = null; return false; }
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: S3CFG.region,
      credentials: { accessKeyId: S3CFG.accessKey, secretAccessKey: S3CFG.secretKey },
      ...(S3CFG.endpoint ? { endpoint: S3CFG.endpoint, forcePathStyle: true } : {}),
    });
    console.log(`[S3] Backup client ready → bucket "${S3CFG.bucket}"${S3CFG.endpoint ? ' @ ' + S3CFG.endpoint : ''}`);
    return true;
  } catch (e) {
    console.warn('[S3] Init failed:', e.message);
    s3Client = null; return false;
  }
}
const S3_ENABLED = () => !!s3Client;
const s3LatestKey = () => `${S3CFG.prefix}db-latest.json`;
const s3DatedKey  = () => `${S3CFG.prefix}history/db-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

async function s3PutJSON(key, obj) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await s3Client.send(new PutObjectCommand({
    Bucket: S3CFG.bucket, Key: key,
    Body: JSON.stringify(obj, null, 2),
    ContentType: 'application/json',
  }));
}
async function s3GetJSON(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const res = await s3Client.send(new GetObjectCommand({ Bucket: S3CFG.bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Push current DB to S3 — overwrites the "latest" object + writes one dated snapshot */
async function s3PushBackup(dated = false) {
  if (!S3_ENABLED()) return { ok: false, message: 'S3 backup not configured' };
  try {
    await s3PutJSON(s3LatestKey(), DB);
    if (dated) await s3PutJSON(s3DatedKey(), DB);
    return { ok: true };
  } catch (e) {
    console.warn('[S3] push failed:', e.message);
    return { ok: false, message: e.message };
  }
}
/** Pull the latest backup from S3 into the local DB (used to recover on ephemeral hosts) */
async function s3PullBackup() {
  if (!S3_ENABLED()) return { ok: false, message: 'S3 backup not configured' };
  try {
    const data = await s3GetJSON(s3LatestKey());
    COLLECTIONS.forEach(c => { if (data[c]) DB[c] = data[c]; });
    saveDB();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
async function s3Test() {
  if (!S3CFG.bucket) return { ok: false, message: 'No bucket configured' };
  if (!initS3()) return { ok: false, message: 'Missing bucket / access key / secret key' };
  try {
    await s3PutJSON(`${S3CFG.prefix}_ping.json`, { ts: Date.now() });
    return { ok: true, message: 'S3 backup connection successful ✅' };
  } catch (e) {
    return { ok: false, message: `S3 error: ${e.message}` };
  }
}

// Debounced push — fires ~10s after the last write, so bursts of edits become one upload
let _s3PushTimer = null;
function s3ScheduleBackup() {
  if (!S3_ENABLED()) return;
  clearTimeout(_s3PushTimer);
  _s3PushTimer = setTimeout(() => { s3PushBackup(false).catch(() => {}); }, 10_000);
}

initS3();
if (S3_ENABLED() && S3CFG.intervalMin > 0) {
  // Periodic safety-net push (also keeps one dated snapshot per interval for history/versioning)
  setInterval(() => { s3PushBackup(true).catch(() => {}); }, S3CFG.intervalMin * 60_000);
}

// ══════════════════════════════════════════════════════════════════
//  HTTP + WebSocket
// ══════════════════════════════════════════════════════════════════
const app    = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors({ origin:'*' }));
app.use(express.json({ limit:'50mb' }));

const clients = new Set();
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type:'hello', collections:COLLECTIONS, timestamp:new Date().toISOString() }));
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'subscribe' && COLLECTIONS.includes(m.collection))
        ws.send(JSON.stringify({ type:'snapshot', collection:m.collection, records:Object.values(DB[m.collection]) }));
    } catch {}
  });
  ws.on('close', () => clients.delete(ws));
});

function broadcast(col, payload, origin = null) {
  const msg = JSON.stringify({ type:'sync', collection:col, payload });
  for (const ws of clients) if (ws !== origin && ws.readyState === ws.OPEN) ws.send(msg);
}

function validateCol(req, res, next) {
  if (!COLLECTIONS.includes(req.params.col)) return res.status(400).json({ error:`Unknown collection: ${req.params.col}` });
  next();
}

// ══════════════════════════════════════════════════════════════════
//  Collection CRUD  →  local + Firebase + Supabase
// ══════════════════════════════════════════════════════════════════
app.get('/api/:col',     validateCol, (req, res) => res.json(Object.values(DB[req.params.col])));
app.get('/api/:col/:id', validateCol, (req, res) => {
  const r = DB[req.params.col][req.params.id];
  r ? res.json(r) : res.status(404).json({ error:'Not found' });
});

app.put('/api/:col/:id', validateCol, requireApiKey, async (req, res) => {
  const { col, id } = req.params;
  const record = { ...req.body, id };
  DB[col][id] = record; saveDB();
  broadcast(col, { op:'set', id, record });
  fbSet(col, id, record);    // mirror → Firebase (non-blocking)
  sbSet(col, id, record);    // mirror → Supabase (non-blocking)
  s3ScheduleBackup();        // mirror → S3 backup (debounced, non-blocking)
  res.json({ ok:true });
});

app.delete('/api/:col/:id', validateCol, requireApiKey, async (req, res) => {
  const { col, id } = req.params;
  if (DB[col][id]) { delete DB[col][id]; saveDB(); broadcast(col, { op:'del', id }); fbDel(col, id); sbDel(col, id); s3ScheduleBackup(); }
  res.json({ ok:true });
});

app.post('/api/bulk/:col', validateCol, requireApiKey, async (req, res) => {
  const { col } = req.params;
  const records = Array.isArray(req.body) ? req.body : Object.values(req.body || {});
  if (!records.length) return res.status(400).json({ error:'Empty payload' });
  records.forEach(r => { if (r?.id) DB[col][r.id] = r; });
  saveDB();
  broadcast(col, { op:'bulk', records });
  fbBulk(col, records);      // mirror → Firebase
  sbBulk(col, records);      // mirror → Supabase
  s3ScheduleBackup();        // mirror → S3 backup
  res.json({ ok:true, count:records.length });
});

// ══════════════════════════════════════════════════════════════════
//  Firebase management endpoints
// ══════════════════════════════════════════════════════════════════
app.get ('/api/_firebase/config', (req, res) => res.json({ url:FB.url, enabled:FB.enabled, hasSecret:!!FB.secret }));
app.post('/api/_firebase/config', requireApiKey, (req, res) => {
  const { url, enabled, secret } = req.body;
  FB.url = (url || '').replace(/\/$/, ''); FB.enabled = enabled !== false && !!FB.url;
  if (secret !== undefined) FB.secret = secret || '';
  writeJSON(FB_CFG, FB);
  res.json({ ok:true, url:FB.url, enabled:FB.enabled });
});
app.post('/api/_firebase/test',   requireApiKey, async (req, res) => res.json(await fbTest()));
app.post('/api/_firebase/push',   requireApiKey, async (req, res) => {
  if (!FB.enabled) return res.status(400).json({ error:'Firebase not enabled' });
  const total = await fbPushAll();
  res.json({ ok:true, total });
});
app.post('/api/_firebase/pull',   requireApiKey, async (req, res) => {
  if (!FB.enabled) return res.status(400).json({ error:'Firebase not enabled' });
  const total = await fbPullAll();
  COLLECTIONS.forEach(c => broadcast(c, { op:'bulk', records:Object.values(DB[c]) }));
  res.json({ ok:true, total });
});

// ══════════════════════════════════════════════════════════════════
//  Supabase management endpoints
// ══════════════════════════════════════════════════════════════════
app.get('/api/_supabase/config', (req, res) => res.json({ url:SB.url, enabled:SB.enabled, hasKey:!!SB.key }));

app.post('/api/_supabase/config', requireApiKey, (req, res) => {
  const { url, key, enabled } = req.body;
  SB.url     = (url || '').replace(/\/$/, '');
  SB.key     = key || SB.key;
  SB.enabled = enabled !== false && !!SB.url && !!SB.key;
  writeJSON(SB_CFG, SB);
  if (SB.enabled) initSupabase(SB.url, SB.key);
  else sbClient = null;
  res.json({ ok:true, url:SB.url, enabled:SB.enabled });
});

app.post('/api/_supabase/test',   requireApiKey, async (req, res) => res.json(await sbTest()));

app.post('/api/_supabase/push',   requireApiKey, async (req, res) => {
  if (!SB.enabled || !sbClient) return res.status(400).json({ error:'Supabase not enabled' });
  try { const total = await sbPushAll(); res.json({ ok:true, total }); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/_supabase/pull',   requireApiKey, async (req, res) => {
  if (!SB.enabled || !sbClient) return res.status(400).json({ error:'Supabase not enabled' });
  try {
    const total = await sbPullAll();
    COLLECTIONS.forEach(c => broadcast(c, { op:'bulk', records:Object.values(DB[c]) }));
    res.json({ ok:true, total });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

/** Return the SQL schema so the UI can display/copy it */
app.get('/api/_supabase/schema', (req, res) => {
  const sql = COLLECTIONS.map(c =>
    `CREATE TABLE IF NOT EXISTS ${c} (\n  id   TEXT PRIMARY KEY,\n  data JSONB NOT NULL DEFAULT '{}'\n);`
  ).join('\n\n') +
  `\n\n-- Enable Realtime for all tables\nALTER PUBLICATION supabase_realtime ADD TABLE\n  ${COLLECTIONS.join(', ')};`;
  res.type('text/plain').send(sql);
});

// ══════════════════════════════════════════════════════════════════
//  S3 backup management endpoints  (feeds Synology Cloud Sync / Hyper Backup)
// ══════════════════════════════════════════════════════════════════
app.get('/api/_backup/config', (req, res) => res.json({
  bucket: S3CFG.bucket, region: S3CFG.region, endpoint: S3CFG.endpoint || null,
  prefix: S3CFG.prefix, intervalMin: S3CFG.intervalMin,
  enabled: S3_ENABLED(), hasKeys: !!(S3CFG.accessKey && S3CFG.secretKey),
  configuredVia: process.env.S3_BUCKET ? 'environment variables' : 'settings file',
}));

app.post('/api/_backup/config', requireApiKey, (req, res) => {
  // Only usable when NOT already fixed by environment variables (env vars always win)
  if (process.env.S3_BUCKET) return res.status(400).json({ error: 'S3 backup is configured via environment variables on this host — edit them in your hosting dashboard.' });
  const { bucket, region, accessKey, secretKey, endpoint, prefix, intervalMin } = req.body;
  const fileCfg = {
    bucket: bucket || '', region: region || 'us-east-1',
    accessKey: accessKey || S3CFG.accessKey, secretKey: secretKey || S3CFG.secretKey,
    endpoint: endpoint || '', prefix: prefix || 'mtss/', intervalMin: +intervalMin || 30,
  };
  writeJSON(S3_CFG_FILE, fileCfg);
  S3CFG = loadS3Config();
  initS3();
  res.json({ ok: true, enabled: S3_ENABLED() });
});

app.post('/api/_backup/test', requireApiKey, async (req, res) => res.json(await s3Test()));

app.post('/api/_backup/push', requireApiKey, async (req, res) => {
  const r = await s3PushBackup(true);
  r.ok ? res.json({ ok: true, message: 'Backup pushed to S3 ✅' }) : res.status(400).json(r);
});

app.post('/api/_backup/pull', requireApiKey, async (req, res) => {
  const r = await s3PullBackup();
  if (r.ok) COLLECTIONS.forEach(c => broadcast(c, { op:'bulk', records:Object.values(DB[c]) }));
  r.ok ? res.json({ ok: true, message: 'Restored from latest S3 backup ✅' }) : res.status(400).json(r);
});

// ── Utility endpoints ─────────────────────────────────────────────
app.get('/api/_health', (req, res) => {
  const counts = {}; COLLECTIONS.forEach(c => { counts[c] = Object.keys(DB[c]).length; });
  res.json({ status:'ok', uptime:process.uptime(), clients:clients.size,
    security:{ apiKeyRequired:true, source:API_KEY_INFO.source },
    firebase:{ enabled:FB.enabled, url:FB.url||null },
    supabase:{ enabled:SB.enabled, url:SB.url||null },
    backup:{ enabled:S3_ENABLED(), bucket:S3CFG.bucket||null, intervalMin:S3CFG.intervalMin },
    records:counts, timestamp:new Date().toISOString() });
});
app.get('/api/_export', requireApiKey, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="mtss-export.json"'); res.json(DB);
});
app.post('/api/_import', requireApiKey, (req, res) => {
  const d = req.body; COLLECTIONS.forEach(c => { if (d[c]) DB[c] = d[c]; }); saveDB();
  COLLECTIONS.forEach(c => broadcast(c, { op:'bulk', records:Object.values(DB[c]) })); res.json({ ok:true });
});
app.delete('/api/_collection/:col', validateCol, requireApiKey, (req, res) => {
  DB[req.params.col] = {}; saveDB();
  broadcast(req.params.col, { op:'bulk', records:[] }); res.json({ ok:true });
});

// ══════════════════════════════════════════════════════════════════
//  Start
// ══════════════════════════════════════════════════════════════════
server.listen(PORT, async () => {
  console.log('');
  console.log('  ✝  Mar Thoma SS Samajam — Realtime Backend  v3');
  console.log('  ──────────────────────────────────────────────────');
  console.log(`  HTTP     → http://localhost:${PORT}/api`);
  console.log(`  WS       → ws://localhost:${PORT}`);
  console.log(`  Health   → http://localhost:${PORT}/api/_health`);
  console.log('');
  console.log('  🔒 SECURITY — API key required for all writes/deletes/config changes');
  console.log(`     Source: ${API_KEY_INFO.source}`);
  if (API_KEY_INFO.source !== 'environment variable') {
    console.log(`     Key: ${API_KEY}`);
    console.log('     ⚠️  Copy this into the app once (Settings → Backend Security Key).');
    console.log('     ⚠️  Only share it with admin / trusted staff — anyone with it can write data.');
    console.log('     For production, set your own API_KEY environment variable instead.');
  } else {
    console.log('     Key is set via the API_KEY environment variable (not shown in logs).');
  }
  console.log('');
  if (FB.enabled && FB.url) {
    console.log(`  Firebase → ${FB.url}  [enabled]`);
    const n = await fbPullAll(); console.log(`  ✅ Firebase pull — ${n} records`);
  }
  if (SB.enabled && SB.url) {
    console.log(`  Supabase → ${SB.url}  [enabled]`);
    if (sbClient) { const n = await sbPullAll(); console.log(`  ✅ Supabase pull — ${n} records`); }
  }
  if (S3_ENABLED()) {
    console.log(`  S3 Backup → bucket "${S3CFG.bucket}"  [enabled, every ${S3CFG.intervalMin}m]`);
    // On a fresh/ephemeral filesystem (e.g. free-tier redeploy) the local DB will be empty —
    // auto-restore the last known-good backup so the app doesn't come up blank.
    const totalLocal = COLLECTIONS.reduce((n, c) => n + Object.keys(DB[c]).length, 0);
    if (totalLocal === 0) {
      const r = await s3PullBackup();
      if (r.ok) console.log('  ✅ Restored data from latest S3 backup (local store was empty)');
      else console.log(`  ⚠️  No S3 backup restored: ${r.message}`);
    } else {
      console.log(`  ℹ️  Local store already has ${totalLocal} records — skipping restore, will back up on next change.`);
    }
  }
  if (!FB.enabled && !SB.enabled && !S3_ENABLED()) console.log('  Running in local-only mode. Configure Firebase, Supabase, or S3 backup via env vars / Settings.');
  console.log('');
});
