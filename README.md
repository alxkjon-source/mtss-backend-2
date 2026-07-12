# MTSS Realtime Backend

Self-hosted WebSocket + REST database server for the **Mar Thoma SS Samajam** data app.
No Firebase account required.

## Quick start (local)

```bash
npm install
npm start          # http://localhost:3001
```

For live-reload during development:

```bash
npm run dev        # requires nodemon (installed as devDependency)
```

---

## Deploying to the cloud (free, via GitHub → Render)

This repo is set up for **Render's free web service tier**, which redeploys automatically
every time you push to GitHub.

### 1. Push this folder to GitHub

```bash
cd mtss-backend
git init
git add .
git commit -m "MTSS backend"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

(`data/` and `.env` are already excluded via `.gitignore` — your local database and secrets
never get committed.)

### 2. Create the service on Render

1. Go to [render.com](https://render.com) → sign in with GitHub → **New +** → **Blueprint**.
2. Select your repo. Render will read `render.yaml` in this folder automatically.
3. Confirm — it creates a **free** Node web service, `npm install` then `npm start`.
4. First deploy takes a minute or two. You'll get a URL like:
   `https://mtss-backend.onrender.com`

> **Free tier note:** Render's free web services spin down after ~15 minutes of no traffic
> and spin back up on the next request (a few seconds' delay). The filesystem is also
> **ephemeral** — anything written to disk is wiped on redeploy/restart. That's exactly what
> the S3 backup layer below solves: the server restores its data from your backup bucket
> automatically on boot if the local store comes up empty.

### 3. Connect the app

Open the app → **Settings** → **MTSS Realtime Backend** → enter your Render URL
(e.g. `https://mtss-backend.onrender.com`) → **Connect Backend**.

### Alternatives to Render

Railway, Fly.io, or any VPS work too — same `npm install && npm start`, just set the `PORT`
env var if your host requires a specific one. `render.yaml` is Render-specific; the others
don't need any extra config file.

---

## Backups → Synology NAS (via S3 + Cloud Sync)

Since the cloud host's disk isn't reliable long-term storage (free tiers especially), the
server can push a full JSON backup to an S3 (or S3-compatible) bucket, and your Synology NAS
pulls from that same bucket automatically using **Cloud Sync** or **Hyper Backup**. Nothing
runs on your NAS that needs to be reachable from the internet — it just syncs *out* from the
bucket on its own schedule.

### 1. Pick a bucket

Any of these work and have usable free tiers:
- **Cloudflare R2** — free egress, generous free tier. Endpoint looks like
  `https://<account-id>.r2.cloudflarestorage.com`.
- **Backblaze B2** — free tier, S3-compatible endpoint.
- **AWS S3** — free tier for the first 12 months.

Create a bucket (e.g. `mtss-backups`) and an access key/secret with read+write access to it.

### 2. Set environment variables on Render

Render dashboard → your service → **Environment** → add:

| Key | Example |
|---|---|
| `S3_BUCKET` | `mtss-backups` |
| `S3_REGION` | `auto` (R2) or e.g. `us-east-1` |
| `S3_ACCESS_KEY_ID` | *(from your provider)* |
| `S3_SECRET_ACCESS_KEY` | *(from your provider)* |
| `S3_ENDPOINT` | *(only for non-AWS providers, e.g. R2/B2 URL above)* |
| `S3_BACKUP_PREFIX` | `mtss/` *(optional)* |
| `S3_BACKUP_INTERVAL_MIN` | `30` *(optional, safety-net push frequency)* |

Save — Render restarts the service with these applied. Backups then happen automatically:
a debounced push ~10s after any data change, plus a full snapshot every `S3_BACKUP_INTERVAL_MIN`
minutes.

Objects written:
- `mtss/db-latest.json` — always the most recent full export (this is what your NAS syncs).
- `mtss/history/db-<timestamp>.json` — one dated snapshot per interval, for version history.

You can test the connection and trigger a manual backup anytime:

```bash
curl -X POST https://mtss-backend.onrender.com/api/_backup/test
curl -X POST https://mtss-backend.onrender.com/api/_backup/push
```

### 3. Point Synology Cloud Sync at the bucket

On your Synology NAS: **Package Center** → install **Cloud Sync** (or use **Hyper Backup** if
you prefer versioned backup sets instead of a live-mirrored folder).

1. Open **Cloud Sync** → **+** → choose your provider (S3 / a generic "S3 Compatible Storage"
   option covers R2/B2 — enter the same endpoint, bucket, and keys as above).
2. Set **sync direction** to **Download only, remote → local** (the NAS should never write
   back to the bucket).
3. Remote path: your bucket → the `mtss/` folder. Local path: wherever you want the backup
   folder on your NAS.
4. Set the sync interval (Cloud Sync can go as low as a few minutes, or use scheduled sync).

Your NAS now always has a current copy of `db-latest.json` plus the dated history folder,
independent of whatever happens to the cloud host.

### Restoring from a backup

If you ever need to restore the live server from the last good backup:

```bash
curl -X POST https://mtss-backend.onrender.com/api/_backup/pull
```

This is also done **automatically on startup** if the server boots with an empty local store
(e.g. after a free-tier redeploy wiped the disk).

---

## Security — API key required for all writes

**Every write, delete, and configuration change now requires a security key.** Reads (viewing
data) stay open so the app can display data normally, but nothing can be created, edited,
deleted, or reconfigured without it. Before this, the API had no authentication at all —
anyone who knew the URL could read, edit, or permanently delete every record, or hijack the
Firebase/Supabase/S3 connections. That gap is now closed.

**No system is "unbreakable"** — this is a real, meaningful improvement (server-side
enforcement, not just hiding buttons in the UI), but it's a single shared key, not individual
per-user logins. Treat it like a master password: share it only with admins / trusted staff,
never in public repos, chat, or screenshots.

### First boot

If you haven't set your own key, the server generates a strong random one automatically and:
- Saves it to `data/security.json` (persists across restarts, excluded from git)
- Prints it **once** in the startup log

Check your Render logs (or terminal, if running locally) right after first deploy:

```
🔒 SECURITY — API key required for all writes/deletes/config changes
   Source: auto-generated just now
   Key: 8f2a1c9e4b7d3f6a1e0c5b8d2a7f4e1c9b6d3a0f7e2c5b8d
   ⚠️  Copy this into the app once (Settings → Backend Security Key).
```

Copy that key into the app: **Settings → MTSS Realtime Backend → Backend Security Key** →
**Connect**. It's saved in the browser from then on.

### Setting your own key (recommended for production)

Set an `API_KEY` environment variable on your host (Render dashboard → Environment) to a long
random value of your choice — this always takes priority over the auto-generated one and
won't print in logs. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### What's protected

| Protected (needs the key) | Open (read-only, no key needed) |
|---|---|
| Create/update/delete any record | View records |
| Bulk import/export | Health check |
| Firebase/Supabase/S3 config changes | Config status (secrets always masked) |
| Wiping a whole collection | Supabase schema text |

### Other things worth knowing

- **HTTPS is required in practice** — Render and Netlify both provide it automatically. Never
  use a plain `http://` link for a real deployment; without TLS, the key could be intercepted
  in transit.
- **Rotating the key**: change the `API_KEY` environment variable (or delete
  `data/security.json` to force a fresh auto-generated one) and re-enter the new key in every
  user's Settings page.
- **Basic brute-force protection** is built in — an IP gets locked out for 10 minutes after 10
  failed key attempts.
- This is a **shared-secret** model, not per-user server-authentication. If you need
  individual user accounts enforced at the server level (not just in the UI), that's a bigger
  upgrade — ask if you'd like help scoping it.

## API reference

| Method | Path | Description | Requires key? |
|--------|------|-------------|:---:|
| GET | `/api/:col` | All records in a collection (array) | No |
| GET | `/api/:col/:id` | Single record | No |
| PUT | `/api/:col/:id` | Upsert one record | 🔒 Yes |
| DELETE | `/api/:col/:id` | Delete one record | 🔒 Yes |
| POST | `/api/bulk/:col` | Upsert many records | 🔒 Yes |
| DELETE | `/api/_collection/:col` | Wipe an entire collection | 🔒 Yes |
| GET | `/api/_health` | Server status + record counts | No |
| GET | `/api/_export` | Full DB dump (JSON) | 🔒 Yes |
| POST | `/api/_import` | Restore from JSON dump | 🔒 Yes |
| GET | `/api/_backup/config` | Current S3 backup config/status (secrets masked) | No |
| POST | `/api/_backup/test` | Test the S3 backup connection | 🔒 Yes |
| POST | `/api/_backup/push` | Trigger an immediate backup push | 🔒 Yes |
| POST | `/api/_backup/pull` | Restore from the latest S3 backup | 🔒 Yes |

Send the key as a header on protected requests: `X-API-Key: <your key>` (the app does this
automatically once you've entered it in Settings).

## Collections

`mt_cand` · `mt_hm` · `mt_users` · `mt_dios` · `mt_cens` · `mt_dist` · `mt_ec` · `mt_cls` · `mt_audit`

## WebSocket

Connect to `ws://localhost:3001` (or `wss://your-host` in the cloud) to receive live sync events:

```json
{ "type": "sync", "collection": "mt_cand", "payload": { "op": "set", "id": "CND_...", "record": { ... } } }
```

`op` values: `set` · `del` · `bulk`

---

## Candidate UID & school transfer (app-side feature)

Every candidate now gets a permanent **Candidate UID** (`CU000001`, `CU000002`, ...) assigned
the first time they're saved. It's shown under the Admission No. in the candidate list, on the
registration slip, and in the Edit Candidate panel — and it never changes.

Admins can transfer a candidate to a different school (button on each row, or "Transfer School"
in the edit panel): the record keeps the same UID, name, DOB, class, category and Register No —
only the school/center/diocese link and the **Admission No.** update, since admission numbers
are assigned per-school. Every transfer is logged to the audit trail.

## Deployment note

> **Note:** `data/db.json` is the local store — see the S3 backup section above for durable
> backups on free/ephemeral hosts. You can also swap the storage layer in `server.js` for
> PostgreSQL / MongoDB if you outgrow the JSON file.
