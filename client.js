/**
 * MTSS Backend Client — drop this into the HTML before </body>
 * Works alongside localStorage; keeps backend in sync.
 * Replace Firebase section with this or use both simultaneously.
 */

// ══════════════════════════════════════════════════════════════════
//  MtssBackend — WebSocket + REST client
// ══════════════════════════════════════════════════════════════════
class MtssBackend {
  constructor(baseUrl, apiKey = '') {
    this.base = baseUrl.replace(/\/$/, '');
    this.wsUrl = this.base.replace(/^http/, 'ws');
    this.apiKey = apiKey || '';
    this.ws    = null;
    this.ready = false;
    this._retryTimer = null;
    this._connect();
  }
  /* Headers for write requests — server rejects writes without a valid key */
  _authHeaders(extra = {}) {
    return this.apiKey ? { ...extra, 'X-API-Key': this.apiKey } : extra;
  }

  /* ── WebSocket connection ─────────────────────────────────── */
  _connect() {
    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        this.ready = true;
        clearTimeout(this._retryTimer);
        const el = document.getElementById('fb-status');
        if (el) el.textContent = '✅ Connected to MTSS Backend';
        toast('Backend connected — syncing data…', 'ok');
        this._pullAll();
      };

      this.ws.onmessage = ({ data }) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'sync') this._applySync(msg);
        } catch { /* ignore */ }
      };

      this.ws.onclose = () => {
        this.ready = false;
        const el = document.getElementById('fb-status');
        if (el) el.textContent = '⚠️ Backend disconnected — retrying in 5 s…';
        this._retryTimer = setTimeout(() => this._connect(), 5000);
      };

      this.ws.onerror = () => { /* handled by onclose */ };
    } catch (e) {
      console.error('[MTSS] WS connect failed:', e);
      this._retryTimer = setTimeout(() => this._connect(), 5000);
    }
  }

  /* ── Apply inbound sync event from server ────────────────── */
  _applySync({ collection, payload }) {
    const { op, id, record, records } = payload;
    if (op === 'set') {
      const arr = lsL(collection).filter(x => x.id !== id);
      arr.push(record);
      lsS(collection, arr);
    } else if (op === 'del') {
      lsS(collection, lsL(collection).filter(x => x.id !== id));
    } else if (op === 'bulk') {
      const arr = lsL(collection);
      (records || []).forEach(r => {
        const i = arr.findIndex(x => x.id === r.id);
        if (i >= 0) arr[i] = r; else arr.push(r);
      });
      lsS(collection, arr);
    }
    // Refresh visible page
    this._refreshUI(collection);
  }

  /* ── Pull all collections from backend on connect ────────── */
  async _pullAll() {
    const cols = [
      'mt_cand','mt_hm','mt_users','mt_dios','mt_cens',
      'mt_dist','mt_ec','mt_cls','mt_audit'
    ];
    for (const col of cols) {
      try {
        const res  = await fetch(`${this.base}/api/${col}`);
        const data = await res.json();

        if (data.length) {
          // Merge: server wins for matching IDs, local-only records kept
          const local  = lsL(col);
          const merged = [...local];
          data.forEach(rec => {
            const i = merged.findIndex(x => x.id === rec.id);
            if (i >= 0) merged[i] = rec; else merged.push(rec);
          });
          lsS(col, merged);
        } else {
          // Push local data up to backend
          const local = lsL(col);
          if (local.length) await this._bulkPush(col, local);
        }
      } catch (e) {
        console.warn('[MTSS] Pull failed for', col, e);
      }
    }
    try { refreshDash();  } catch { /* page may not be active */ }
    try { renderCand();   } catch { }
    toast('Sync complete', 'ok');
  }

  /* ── Write one record to backend ─────────────────────────── */
  async set(collection, id, record) {
    if (!this.ready) return;
    try {
      const res = await fetch(`${this.base}/api/${collection}/${id}`, {
        method:  'PUT',
        headers: this._authHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify(record)
      });
      if (res.status === 401) toast('Backend rejected the write — check the Backend Security Key in Settings', 'err');
    } catch (e) {
      console.warn('[MTSS] set failed:', e);
    }
  }

  /* ── Delete one record from backend ──────────────────────── */
  async del(collection, id) {
    if (!this.ready) return;
    try {
      const res = await fetch(`${this.base}/api/${collection}/${id}`, { method: 'DELETE', headers: this._authHeaders() });
      if (res.status === 401) toast('Backend rejected the delete — check the Backend Security Key in Settings', 'err');
    } catch (e) {
      console.warn('[MTSS] del failed:', e);
    }
  }

  /* ── Push a local array to backend ───────────────────────── */
  async _bulkPush(collection, records) {
    try {
      const res = await fetch(`${this.base}/api/bulk/${collection}`, {
        method:  'POST',
        headers: this._authHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify(records)
      });
      if (res.status === 401) toast('Backend rejected the sync — check the Backend Security Key in Settings', 'err');
    } catch (e) {
      console.warn('[MTSS] bulk push failed:', e);
    }
  }

  /* ── Minimal UI refresh after inbound sync ───────────────── */
  _refreshUI(col) {
    const page = document.querySelector('.page.active');
    if (!page) return;
    if (col === 'mt_cand') {
      if (page.id === 'page-cand-list') try { renderCand(); } catch { }
      if (page.id === 'page-candidate') {
        const sId = document.getElementById('cd-sch')?.value;
        if (sId) try { showSDP(sId); } catch { }
      }
    }
    if (col === 'mt_hm' && page.id === 'page-hm-list') try { renderHM(); } catch { }
    try { refreshDash(); } catch { }
  }

  disconnect() {
    clearTimeout(this._retryTimer);
    if (this.ws) this.ws.close();
    this.ready = false;
  }
}

// ══════════════════════════════════════════════════════════════════
//  Global instance — attached to STATE
// ══════════════════════════════════════════════════════════════════
let BACKEND = null;

function connectBackend(url, apiKey) {
  if (!url) return;
  if (BACKEND) BACKEND.disconnect();
  const key = apiKey !== undefined ? apiKey : (lsG('mt_backend_key') || '');
  BACKEND = new MtssBackend(url, key);
  lsS('mt_backend_url', url);
  if (apiKey !== undefined) lsS('mt_backend_key', apiKey);
}

function disconnectBackend() {
  if (BACKEND) { BACKEND.disconnect(); BACKEND = null; }
  localStorage.removeItem('mt_backend_url');
  const el = document.getElementById('fb-status');
  if (el) el.textContent = 'Not connected';
  toast('Backend disconnected', 'warn');
}

// Auto-reconnect on page load if URL was saved
(function () {
  const saved = lsG('mt_backend_url');
  if (saved) connectBackend(saved, lsG('mt_backend_key') || '');
})();
