// OrthoDeck to Dropbox sync.
//
// Why Dropbox and not Drive: Dropbox issues refresh tokens to public (no
// secret) PKCE clients, so a phone that has been connected once keeps syncing
// without another sign-in. Google's browser flow gives one-hour access tokens
// and no refresh token.
//
// The app is registered with "App folder" access, so everything below lives in
// /Apps/OrthoDeck and Dropbox never grants sight of anything else.
//
//   /state.json                        every synced record, images by reference
//   /images/<sha256>                   card photos, uploaded once, never rewritten
//   /snapshots/state-YYYY-MM-DD.json   weekly rollback copies, last 10 kept
//
// Sync is a merge, not an overwrite: each record carries `u` (last local write)
// and the newer side wins per record, so studying on the phone while editing on
// a laptop does not cost you either set of changes.
const Sync = (() => {
  const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
  const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  const RPC = 'https://api.dropboxapi.com/2/';
  const CONTENT = 'https://content.dropboxapi.com/2/';
  const STATE_PATH = '/state.json';
  const IMG_DIR = '/images';
  const SNAP_DIR = '/snapshots';
  const SNAP_KEEP = 10;
  const SNAP_EVERY = 7 * 24 * 3600 * 1000;
  const TOMB_TTL = 90 * 24 * 3600 * 1000;
  const STORES = ['progress', 'overrides', 'usercards', 'stats', 'queue', 'settings'];
  // Kept on this device only: credentials, and the sync bookkeeping itself.
  const LOCAL_ONLY = ['apiKey', 'gKey', 'gCx', 'dbxKey', 'dbxRefresh', 'dbxRev', 'dbxLastSync', 'dbxLastSnapshot', 'dbxFreq', 'statsLocalDay'];
  const LS_VERIFIER = 'od-dbx-verifier', LS_STATE = 'od-dbx-state', LS_KEY = 'od-dbx-key';

  let host = { settings: () => ({}), save: async () => {}, reload: async () => {}, onStatus: () => {} };
  let access = { token: '', exp: 0 };
  let running = null;

  // ---------- small helpers ----------
  const ls = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
    del: (k) => { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const b64url = (buf) => btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a.buffer).slice(0, n); };
  const sha256 = (str) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(b64url);
  // Dropbox passes call arguments in an HTTP header, which must be ASCII.
  const argHeader = (o) => JSON.stringify(o).replace(/[-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

  function redirectUri() { return location.origin + location.pathname; }

  // ---------- OAuth (PKCE, offline) ----------
  async function connect(appKey) {
    if (!appKey) throw new Error('Enter your Dropbox app key first');
    const verifier = rand(64), state = rand(16);
    ls.set(LS_VERIFIER, verifier); ls.set(LS_STATE, state); ls.set(LS_KEY, appKey);
    const q = new URLSearchParams({
      client_id: appKey, response_type: 'code', redirect_uri: redirectUri(),
      code_challenge: await sha256(verifier), code_challenge_method: 'S256',
      token_access_type: 'offline', state: state
    });
    location.href = AUTH_URL + '?' + q.toString();
  }

  // Called once at boot. Returns the refresh token if we just came back from
  // Dropbox, null otherwise. The query string is cleaned either way so a reload
  // does not try to spend the same code twice.
  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    const code = p.get('code'), state = p.get('state'), err = p.get('error');
    if (!code && !err) return null;
    const clean = () => history.replaceState(null, '', redirectUri() + location.hash);
    if (err) { clean(); throw new Error(p.get('error_description') || err); }
    const verifier = ls.get(LS_VERIFIER), expect = ls.get(LS_STATE), appKey = ls.get(LS_KEY);
    clean();
    if (!verifier || !appKey) throw new Error('Sign-in did not start on this device');
    if (expect && state !== expect) throw new Error('Sign-in state mismatch - try again');
    const body = new URLSearchParams({ code: code, grant_type: 'authorization_code', code_verifier: verifier, client_id: appKey, redirect_uri: redirectUri() });
    const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error_summary || 'Dropbox sign-in failed');
    ls.del(LS_VERIFIER); ls.del(LS_STATE);
    access = { token: j.access_token, exp: Date.now() + (j.expires_in || 14400) * 1000 - 60000 };
    return { refresh: j.refresh_token || '', appKey: appKey };
  }

  async function token() {
    if (access.token && Date.now() < access.exp) return access.token;
    const s = host.settings();
    if (!s.dbxRefresh || !s.dbxKey) throw new Error('Dropbox is not connected');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.dbxRefresh, client_id: s.dbxKey });
    const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(/revoked|invalid/i.test(j.error_description || '') ? 'Dropbox access was revoked - reconnect in Settings' : (j.error_description || 'Could not refresh Dropbox access'));
    access = { token: j.access_token, exp: Date.now() + (j.expires_in || 14400) * 1000 - 60000 };
    return access.token;
  }

  // ---------- transport ----------
  async function rpc(endpoint, arg) {
    const r = await fetch(RPC + endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' }, body: JSON.stringify(arg) });
    if (r.status === 409) return { _conflict: await r.json().catch(() => ({})) };
    if (!r.ok) throw new Error('Dropbox ' + endpoint + ': ' + (await r.text()).slice(0, 200));
    return r.status === 204 ? {} : r.json();
  }
  async function upload(path, blob, mode) {
    const arg = { path: path, mode: mode || 'overwrite', autorename: false, mute: true };
    const r = await fetch(CONTENT + 'files/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': argHeader(arg) }, body: blob });
    if (r.status === 409) return { _conflict: await r.json().catch(() => ({})) };
    if (!r.ok) throw new Error('Dropbox upload: ' + (await r.text()).slice(0, 200));
    return r.json();
  }
  async function download(path) {
    const r = await fetch(CONTENT + 'files/download', { method: 'POST', headers: { Authorization: 'Bearer ' + (await token()), 'Dropbox-API-Arg': argHeader({ path: path }) } });
    if (r.status === 409) return null; // not found
    if (!r.ok) throw new Error('Dropbox download: ' + (await r.text()).slice(0, 200));
    return r;
  }

  // ---------- images ----------
  const dataUrlToBlob = (d) => {
    const parts = d.split(','), mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(parts[1]), a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: mime });
  };
  const blobToDataUrl = (b) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('Could not read image')); fr.readAsDataURL(b); });

  // Replace inline data: URLs with { dbx: <hash> } references, uploading any
  // image Dropbox has not seen. Photos are the bulk of the data and never
  // change once added, so this keeps a routine sync to a few hundred kB.
  async function externalize(records, index, progress) {
    let uploaded = 0;
    const out = [];
    for (const rec of records) {
      if (!rec.images || !rec.images.length) { out.push(rec); continue; }
      const copy = Object.assign({}, rec, { images: [] });
      for (const im of rec.images) {
        if (typeof im === 'string' && im.indexOf('data:') === 0) {
          const hash = (await sha256(im)).slice(0, 32);
          const mime = (im.match(/:(.*?);/) || [])[1] || 'image/jpeg';
          if (!index[hash]) {
            await upload(IMG_DIR + '/' + hash, dataUrlToBlob(im), 'add');
            index[hash] = { mime: mime };
            uploaded++;
            if (progress) progress(uploaded);
          }
          copy.images.push({ dbx: hash, mime: mime });
        } else copy.images.push(im);
      }
      out.push(copy);
    }
    return out;
  }

  // Turn { dbx: hash } references back into data: URLs for local storage, so
  // the rest of the app never has to know sync exists.
  async function internalize(records, cache) {
    for (const rec of records) {
      if (!rec.images || !rec.images.length) continue;
      const imgs = [];
      for (const im of rec.images) {
        if (im && im.dbx) {
          if (cache[im.dbx] === undefined) {
            try { const r = await download(IMG_DIR + '/' + im.dbx); cache[im.dbx] = r ? await blobToDataUrl(await r.blob()) : null; }
            catch (e) { cache[im.dbx] = null; }
          }
          if (cache[im.dbx]) imgs.push(cache[im.dbx]);
        } else imgs.push(im);
      }
      rec.images = imgs;
    }
    return records;
  }

  // ---------- local state ----------
  async function readLocal() {
    const out = { v: 1, stores: {}, tombstones: [], images: {} };
    for (const s of STORES) out.stores[s] = await DB.getAll(s);
    out.stores.settings = (out.stores.settings || []).map((rec) => {
      const c = Object.assign({}, rec);
      LOCAL_ONLY.forEach((k) => delete c[k]);
      return c;
    });
    const cutoff = Date.now() - TOMB_TTL;
    out.tombstones = (await DB.getAll('tombstones')).filter((t) => (t.u || 0) > cutoff);
    return out;
  }

  const newest = (a, b) => (((a && a.u) || 0) >= ((b && b.u) || 0) ? a : b);

  function mergeState(local, remote) {
    const merged = { v: 1, stores: {}, tombstones: [], images: Object.assign({}, remote.images || {}, local.images || {}) };
    const tombs = {};
    [].concat(remote.tombstones || [], local.tombstones || []).forEach((t) => { tombs[t.id] = newest(t, tombs[t.id]); });
    for (const store of STORES) {
      const m = {};
      ((remote.stores || {})[store] || []).forEach((r) => { m[r.id] = r; });
      ((local.stores || {})[store] || []).forEach((r) => {
        const e = m[r.id];
        // Daily review counts are per-device tallies, not a shared value:
        // taking the larger count keeps a day studied on both devices honest.
        if (e && store === 'stats') m[r.id] = { id: r.id, reviews: Math.max(e.reviews || 0, r.reviews || 0), new: Math.max(e.new || 0, r.new || 0), u: Math.max(e.u || 0, r.u || 0) };
        else m[r.id] = newest(r, e);
      });
      // A delete beats any record older than it.
      Object.keys(m).forEach((id) => { const t = tombs[store + ':' + id]; if (t && (t.u || 0) > (m[id].u || 0)) delete m[id]; });
      merged.stores[store] = Object.keys(m).map((k) => m[k]);
    }
    const cutoff = Date.now() - TOMB_TTL;
    merged.tombstones = Object.keys(tombs).map((k) => tombs[k]).filter((t) => (t.u || 0) > cutoff);
    return merged;
  }

  // Write merged records back, but only the ones that actually changed here.
  async function applyLocal(merged, local, force) {
    const imgCache = {};
    let changed = 0;
    for (const store of STORES) {
      const before = {};
      (((local.stores || {})[store]) || []).forEach((r) => { before[r.id] = r; });
      const incoming = merged.stores[store].filter((r) => force || !before[r.id] || (r.u || 0) > (before[r.id].u || 0));
      if (incoming.length) {
        const ready = await internalize(incoming.map((r) => Object.assign({}, r)), imgCache);
        if (store === 'settings') {
          // Never let another device's copy clobber this one's keys.
          const mine = (await DB.get('settings', 'main')) || {};
          ready.forEach((r) => { LOCAL_ONLY.forEach((k) => { if (mine[k] !== undefined) r[k] = mine[k]; }); });
        }
        await DB.putMany(store, ready, { stamp: false });
        changed += ready.length;
      }
      const keep = {};
      merged.stores[store].forEach((r) => { keep[r.id] = 1; });
      for (const id of Object.keys(before)) if (!keep[id]) { await DB.delRaw(store, id); changed++; }
    }
    if (merged.tombstones.length) await DB.putMany('tombstones', merged.tombstones, { stamp: false });
    return changed;
  }

  // ---------- snapshots ----------
  async function snapshots() {
    const r = await rpc('files/list_folder', { path: SNAP_DIR });
    if (r._conflict) return [];
    return (r.entries || []).filter((e) => e['.tag'] === 'file').sort((a, b) => (a.name < b.name ? 1 : -1))
      .map((e) => ({ path: e.path_lower, name: e.name, size: e.size, at: e.server_modified }));
  }
  async function prune() {
    const list = await snapshots();
    for (const old of list.slice(SNAP_KEEP)) await rpc('files/delete_v2', { path: old.path }).catch(() => {});
  }

  // ---------- the sync itself ----------
  async function run(opts) {
    opts = opts || {};
    if (running) return running;
    running = (async () => {
      const s = host.settings();
      if (!s.dbxRefresh) throw new Error('Dropbox is not connected');
      host.onStatus('Reading local data...');
      const local = await readLocal();

      host.onStatus('Fetching from Dropbox...');
      let remote = { stores: {}, tombstones: [], images: {} }, rev = '';
      const resp = await download(STATE_PATH);
      if (resp) {
        try { rev = JSON.parse(resp.headers.get('dropbox-api-result') || '{}').rev || ''; } catch (e) {}
        try { remote = JSON.parse(await resp.text()); }
        catch (e) { throw new Error('The Dropbox copy is unreadable - restore from a snapshot instead'); }
      }

      const merged = mergeState(local, remote);

      host.onStatus('Uploading photos...');
      for (const store of ['overrides', 'usercards']) {
        merged.stores[store] = await externalize(merged.stores[store], merged.images, (n) => host.onStatus('Uploading photos... ' + n));
      }

      host.onStatus('Saving...');
      const body = new Blob([JSON.stringify(merged)], { type: 'application/json' });
      const mode = rev ? { '.tag': 'update', update: rev } : 'add';
      const put = await upload(STATE_PATH, body, mode);
      if (put._conflict) {
        // Another device wrote while we were merging. Start over once.
        running = null;
        if (opts._retry) throw new Error('Dropbox is busy - try Sync now again');
        return run(Object.assign({}, opts, { _retry: true }));
      }

      const now = Date.now();
      if (now - (s.dbxLastSnapshot || 0) > SNAP_EVERY) {
        const day = new Date().toISOString().slice(0, 10);
        await upload(SNAP_DIR + '/state-' + day + '.json', body, 'overwrite').catch(() => {});
        await prune().catch(() => {});
        s.dbxLastSnapshot = now;
      }

      host.onStatus('Applying...');
      const changed = await applyLocal(merged, local, false);
      s.dbxLastSync = now;
      s.dbxRev = (put && put.rev) || rev;
      await host.save();
      if (changed) await host.reload();
      const counts = {};
      STORES.forEach((k) => { counts[k] = merged.stores[k].length; });
      host.onStatus('');
      return { changed: changed, counts: counts, images: Object.keys(merged.images).length, at: now };
    })().finally(() => { running = null; });
    return running;
  }

  // Pull one snapshot over the top of whatever is here. This is the "my phone
  // wiped itself" path, so remote wins outright rather than merging.
  async function restore(path) {
    const resp = await download(path || STATE_PATH);
    if (!resp) throw new Error('Nothing to restore from');
    const remote = JSON.parse(await resp.text());
    host.onStatus('Restoring...');
    const local = await readLocal();
    const merged = mergeState({ stores: {}, tombstones: [], images: {} }, remote);
    const changed = await applyLocal(merged, local, true);
    host.onStatus('');
    await host.reload();
    return { changed: changed };
  }

  function due(s) {
    if (!s.dbxRefresh) return false;
    const since = Date.now() - (s.dbxLastSync || 0);
    if (s.dbxFreq === 'manual') return false;
    if (s.dbxFreq === 'open') return since > 5 * 60 * 1000;
    if (s.dbxFreq === 'daily') return since > 24 * 3600 * 1000;
    return since > 7 * 24 * 3600 * 1000;
  }

  return {
    init: (h) => { host = Object.assign(host, h); },
    connect: connect,
    handleRedirect: handleRedirect,
    run: run,
    restore: restore,
    snapshots: snapshots,
    due: due,
    redirectUri: redirectUri,
    connected: () => !!host.settings().dbxRefresh,
    disconnect: async () => { const s = host.settings(); s.dbxRefresh = ''; s.dbxRev = ''; s.dbxLastSync = 0; access = { token: '', exp: 0 }; await host.save(); },
    _merge: mergeState
  };
})();
