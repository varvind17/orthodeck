/* Cellar Book — core: constants, helpers, local storage (IndexedDB), settings, data changes. */
'use strict';

const APP_VERSION = '2.0.1';

const RATINGS = [
  { key: 'love', label: 'Love', score: 3 },
  { key: 'like', label: 'Like', score: 2 },
  { key: 'meh', label: 'Meh', score: 1 },
  { key: 'dislike', label: 'Dislike', score: 0 },
];
const RMAP = Object.fromEntries(RATINGS.map(r => [r.key, r]));
const COLORS = [
  ['red', 'Red'], ['white', 'White'], ['rose', 'Rosé'], ['sparkling', 'Sparkling'],
  ['orange', 'Orange'], ['dessert', 'Dessert'], ['fortified', 'Fortified'],
];
const CMAP = Object.fromEntries(COLORS);
const TABS = ['journal', 'cellar', 'ask', 'map', 'pick', 'palate'];
const MODELS = [
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (recommended)'],
  ['claude-opus-5-5', 'Claude Opus 5.5 (most capable, ~2× cost)'],
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (fastest, cheapest)'],
];

/* ---------- Small helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('en-CA');
const nowIso = () => new Date().toISOString();
const clone = o => JSON.parse(JSON.stringify(o || {}));
const yearNow = new Date().getFullYear();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtDate = d => {
  if (!d) return '';
  const dt = new Date(d + 'T12:00:00');
  if (isNaN(dt)) return d;
  const opts = dt.getFullYear() === yearNow ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' };
  return dt.toLocaleDateString(undefined, opts);
};
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const slug = s => norm(s).replace(/ /g, '-').slice(0, 80);
const colorVar = c => `var(--w-${CMAP[c] ? c : 'red'})`;
const grapesOf = w => Array.isArray(w.grapes) ? w.grapes.filter(Boolean) : String(w.grapes || '').split(',').map(s => s.trim()).filter(Boolean);
const placeOf = w => [w.region, w.country].filter(Boolean).join(', ');
const isTasted = w => !!w.rating || (w.tastings && w.tastings.length);
const wineLabel = w => [w.producer, w.name, w.vintage || 'NV'].filter(Boolean).join(' ');
const randId = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2800);
}

/* ---------- App state ---------- */
const S = {
  data: { wines: {}, profile: null, deleted: {}, updated_at: null },
  wines: new Map(), loaded: false,
  tab: 'journal', rfilter: 'all', cfilter: 'all', q: '', sort: 'recent',
  detailId: null, delArm: false, ed: null,
  pickWhere: 'restaurant', pickImgs: [], pickCtl: null, pickResult: null,
};

/* ---------- Settings (this device only) ---------- */
const SETTINGS_KEY = 'cellarbook.settings';
const settings = (() => {
  let v = {};
  try { v = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) {}
  return Object.assign({ apiKey: '', model: MODELS[0][0], webSearch: true, autoStory: true, saveLocation: true, dbxAppKey: '', dbx: null, lastSync: null, lastBackup: null }, v);
})();
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }
const hasClaude = () => !!settings.apiKey;

/* ---------- IndexedDB ---------- */
const IDB = {
  db: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((res, rej) => {
      const req = indexedDB.open('cellar-book', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
      };
      req.onsuccess = () => { this.db = req.result; res(this.db); };
      req.onerror = () => rej(req.error);
    });
    return this._p;
  },
  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const st = t.objectStore(store);
      let out;
      Promise.resolve(fn(st)).then(v => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  get(store, key) {
    return this.tx(store, 'readonly', st => new Promise(r => { const q = st.get(key); q.onsuccess = () => r(q.result); q.onerror = () => r(undefined); }));
  },
  put(store, key, val) { return this.tx(store, 'readwrite', st => { st.put(val, key); }); },
  del(store, key) { return this.tx(store, 'readwrite', st => { st.delete(key); }); },
  keys(store) {
    return this.tx(store, 'readonly', st => new Promise(r => { const q = st.getAllKeys(); q.onsuccess = () => r(q.result || []); q.onerror = () => r([]); }));
  },
};

/* ---------- Data changes ---------- */
function rebuildIndex() {
  S.wines = new Map(Object.entries(S.data.wines || {}).map(([id, w]) => [id, { ...w, id }]));
}
let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { IDB.put('state', 'main', S.data).catch(() => toast('Couldn’t save on this device. Storage may be full.')); }, 50);
}
function changed() {
  S.data.updated_at = nowIso();
  rebuildIndex(); persist();
  if (typeof renderAll === 'function') renderAll();
  if (typeof scheduleSync === 'function') scheduleSync();
}
function putWine(id, data) {
  const { id: _drop, ...body } = clone(data);
  body.updated_at = nowIso();
  S.data.wines[id] = body;
  if (S.data.deleted) delete S.data.deleted[id];
  changed();
  if (typeof kickQueue === 'function') kickQueue();
  return id;
}
function patchWine(id, patch) {
  const cur = S.data.wines[id]; if (!cur) return;
  putWine(id, { ...cur, ...patch });
}
function deleteWine(id) {
  delete S.data.wines[id];
  (S.data.deleted = S.data.deleted || {})[id] = nowIso();
  changed();
}
function setProfile(p) {
  S.data.profile = { ...p, updated_at: nowIso() };
  changed();
}

function recalc(w) {
  const ts = (w.tastings || []).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  w.tastings = ts;
  const rated = ts.filter(t => RMAP[t.rating]);
  w.rating = rated.length ? rated[rated.length - 1].rating : null;
  const dated = ts.filter(t => t.date);
  w.last_tasted = dated.length ? dated[dated.length - 1].date : null;
}
function findMatch(f, exceptId) {
  const key = norm([f.producer, f.name, f.vintage || 'nv'].join(' '));
  for (const w of S.wines.values()) if (w.id !== exceptId && norm([w.producer, w.name, w.vintage || 'nv'].join(' ')) === key) return w;
  return null;
}
function newId(f) {
  const base = slug([f.producer, f.name, f.vintage || 'nv'].filter(Boolean).join(' ')) || 'wine';
  let id = base, i = 2;
  while (S.wines.has(id) || S.data.wines[id]) id = `${base}-${i++}`;
  return id;
}
function blankWine(extra = {}) {
  return {
    producer: '', name: '', vintage: null, color: null, grapes: [], country: '', region: '', appellation: '',
    origin: null, body: null, tasting_profile: '', food_pairing: '', about: '', story: null,
    drink_from: null, drink_to: null, price_usd: null, rating: null, notes: '', tastings: [], last_tasted: null,
    bottles: 0, location: '', paid: null, wishlist: false, label_photo: null, source: 'app', created_at: nowIso(), ...extra,
  };
}

/* ---------- Photos (stored on device, uploaded to Dropbox) ---------- */
const photoUrls = new Map();
async function savePhoto(blob) {
  const id = randId('p-');
  await IDB.put('photos', id, { blob, uploaded: false, at: nowIso() });
  photoUrls.set(id, URL.createObjectURL(blob));
  if (typeof scheduleSync === 'function') scheduleSync();
  return id;
}
async function photoUrl(id) {
  if (!id) return null;
  if (photoUrls.has(id)) return photoUrls.get(id);
  const rec = await IDB.get('photos', id).catch(() => null);
  if (rec && rec.blob) { const u = URL.createObjectURL(rec.blob); photoUrls.set(id, u); return u; }
  if (typeof fetchPhotoFromDropbox === 'function') {
    const blob = await fetchPhotoFromDropbox(id).catch(() => null);
    if (blob) { await IDB.put('photos', id, { blob, uploaded: true, at: nowIso() }); const u = URL.createObjectURL(blob); photoUrls.set(id, u); return u; }
  }
  return null;
}
function dataUrlToBlob(u) {
  const [head, b64] = u.split(',');
  const type = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}
function blobToBase64(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
}

/* Phone photos are large; shrink to ~1600px JPEG before sending or storing. */
async function shrinkImage(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
    return blob || file;
  } catch (e) { return file; }
}

/* Location and time saved inside a photo, when the phone included them. */
async function readPhotoMeta(file) {
  const out = { gps: null, date: null };
  try {
    if (!window.exifr) return out;
    const g = await window.exifr.gps(file).catch(() => null);
    if (g && isFinite(g.latitude) && isFinite(g.longitude) && !(g.latitude === 0 && g.longitude === 0)) out.gps = { lat: +g.latitude.toFixed(5), lng: +g.longitude.toFixed(5) };
    const t = await window.exifr.parse(file, ['DateTimeOriginal']).catch(() => null);
    const d = t && t.DateTimeOriginal;
    if (d instanceof Date && !isNaN(d) && d <= new Date()) out.date = d.toLocaleDateString('en-CA');
  } catch (e) {}
  return out;
}

/* ---------- Location (live GPS + OpenStreetMap place names) ---------- */
function currentPosition(timeout = 9000) {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: +p.coords.latitude.toFixed(5), lng: +p.coords.longitude.toFixed(5) }),
      () => res(null), { enableHighAccuracy: true, timeout, maximumAge: 120000 });
  });
}
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lng}`, { headers: { 'Accept-Language': 'en' } });
    const j = await r.json();
    const a = j.address || {};
    const spot = j.name && j.name !== a.road ? j.name : '';
    const area = a.neighbourhood || a.suburb || a.quarter || a.village || a.town || '';
    const city = a.city || a.town || a.village || a.county || '';
    return [spot, area && area !== city ? area : '', city].filter(Boolean).join(', ') || j.display_name || '';
  } catch (e) { return ''; }
}
async function geocode(text) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(text)}`, { headers: { 'Accept-Language': 'en' } });
    const j = await r.json();
    if (j && j[0]) return { lat: +(+j[0].lat).toFixed(4), lng: +(+j[0].lon).toFixed(4) };
  } catch (e) {}
  return null;
}

function windowStatus(w) {
  const f = parseInt(w.drink_from) || null, t = parseInt(w.drink_to) || null;
  if (!f && !t) return null;
  if (f && yearNow < f) return { k: 'hold', label: `Hold until ${f}` };
  if (t && yearNow > t) return { k: 'past', label: `Past window · ${t}` };
  if (t && t - yearNow <= 1) return { k: 'soon', label: `Drink by ${t}` };
  return { k: 'ready', label: t ? `Ready · to ${t}` : 'Ready' };
}
function rateChip(r) {
  if (!r || !RMAP[r]) return '';
  return `<span class="rate r-${r}">${RMAP[r].label}</span>`;
}
