/* OrthoDeck — app.js v3
   FSRS-5 scheduler (default parameters) with Anki-style learning steps, sibling burying,
   leech handling, flags/suspend, cloze + reverse cards, related-card links, chapter importer
   with page picker and review queue, deck sharing, post-session "explain my misses", stats. */

(() => {
  'use strict';

  // ---------- constants ----------
  const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
  const LEARN_STEPS = [1, 10], RELEARN_STEPS = [10];
  const LEARN_AHEAD = 20 * MIN;
  const APP_VERSION = 'v3.0';
  const DEFAULTS = {
    id: 'main', newPerDay: 40, maxReviews: 200, domains: DOMAINS.map((d) => d.key),
    apiKey: '', model: 'claude-sonnet-4-6', gKey: '', gCx: '', dayStart: 4,
    retention: 0.9, burySiblings: true, reverse: true, leechThreshold: 8, leechAction: 'suspend', examDate: ''
  };
  const TYPES = { classification: 'Classification', anatomy: 'Anatomy / approach', diagnosis: 'Diagnosis', management: 'Management', cloze: 'Cloze' };
  const FLAGS = { '': 'None', verify: 'Verify against source', notboard: 'Not board-relevant', hard: 'Keeps tripping me', fix: 'Needs rewrite' };
  const DOMAIN_BY_KEY = Object.fromEntries(DOMAINS.map((d) => [d.key, d]));

  // ---------- state ----------
  let settings = { ...DEFAULTS };
  let progress = {}, overrides = {}, userCards = {}, stats = {}, queue = {};
  let session = null, current = null, revealed = false;
  let chatCard = null, editCard = null, editImages = [], previewCard = null, importJob = null;
  let cardIndex = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  function todayKey(offsetDays = 0) {
    const d = new Date(); d.setHours(d.getHours() - (settings.dayStart ?? 4)); d.setDate(d.getDate() + offsetDays);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function imgEl(im) {
    const el = document.createElement('img'); el.alt = '';
    if (typeof im === 'string') { el.src = im; return el; }
    el.src = im.url; el.onerror = () => { if (im.thumb && el.src !== im.thumb) el.src = im.thumb; };
    if (!im.credit) return el;
    const w = document.createElement('div'); w.appendChild(el);
    const c = document.createElement('div'); c.className = 'imgcap'; c.textContent = im.credit; w.appendChild(c); return w;
  }

  // ---------- cloze helpers ----------
  const CLOZE_RE = /\{\{c\d+::([^}]*?)(?:::[^}]*)?\}\}/g;
  const hasCloze = (q) => /\{\{c\d+::/.test(q || '');
  const isCloze = (c) => c.t === 'cloze' || hasCloze(c.q);
  const clozeFront = (q) => esc(q).replace(/\{\{c\d+::([^}]*?)(?:::([^}]*))?\}\}/g, (m, a, hint) => `<span class="clozegap">[${hint ? esc(hint) : '…'}]</span>`);
  const clozeBack = (q) => esc(q).replace(/\{\{c\d+::([^}]*?)(?:::[^}]*)?\}\}/g, (m, a) => `<mark>${esc(a)}</mark>`);
  const clozePlain = (q) => String(q || '').replace(CLOZE_RE, '$1');

  // ---------- family (sibling) key ----------
  const GRADE_TOK = /^(i{1,3}v?|iv|vi{0,3}|[a-e]|\d+[a-e]?|[a-e]\/[a-e]|type|types|stage|stages|grade|grades|class|zone|zones|vs|and|&|part|level|only|→|-|—|–)$/i;
  function familyKey(card, baseQ) {
    const toks = clozePlain(baseQ).replace(/[:,()?]/g, ' ').trim().split(/\s+/);
    let n = toks.length; while (n > 1 && GRADE_TOK.test(toks[n - 1])) n--;
    if (n === toks.length || n < 1) return null;
    return card.d + '|' + toks.slice(0, n).join(' ').toLowerCase();
  }

  // ---------- cards ----------
  function resolve(c) { const o = overrides[c.id]; return o ? { ...c, q: o.q ?? c.q, a: o.a ?? c.a, images: o.images || [], edited: true } : { ...c, images: [] }; }
  function allCards(force) {
    if (cardIndex && !force) return cardIndex;
    const list = SEED_CARDS.map(resolve).concat(Object.values(userCards).map((c) => ({ ...c, user: true })));
    list.forEach((c) => { c.fam = familyKey(c, c.q); });
    if (settings.reverse) {
      const rev = [];
      list.forEach((c) => { if (c.t === 'classification' && !isCloze(c) && c.a.length < 90) rev.push({ ...c, id: c.id + '_r', q: c.a, a: c.q, reverse: true, parent: c.id, images: [], fam: c.fam }); });
      list.push(...rev);
    }
    cardIndex = list; return list;
  }
  const invalidate = () => { cardIndex = null; };
  function cardById(id) { return allCards().find((c) => c.id === id) || null; }
  function prog(id) { return progress[id] || { id, state: 'new', S: 0, D: 5, due: 0, last: 0, reps: 0, lapses: 0, step: 0, suspended: false, flag: '', leech: false }; }

  // ---------- FSRS-5 ----------
  const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
  const FACTOR = 19 / 81, DECAY = -0.5;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const retr = (t, S) => Math.pow(1 + FACTOR * t / S, DECAY);
  const ivlFor = (S) => clamp(Math.round(S / FACTOR * (Math.pow(settings.retention, 1 / DECAY) - 1)), 1, 365);
  const S0 = (g) => W[g - 1];
  const D0 = (g) => clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10);
  function nextD(D, g) { const d1 = D - W[6] * (g - 3) * (10 - D) / 9; return clamp(W[7] * D0(4) + (1 - W[7]) * d1, 1, 10); }
  const sRecall = (S, D, R, g) => S * (Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9]) * (Math.exp(W[10] * (1 - R)) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1) + 1);
  const sForget = (S, D, R) => Math.min(W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1) * Math.exp(W[14] * (1 - R)), S);
  const sShort = (S, g) => S * Math.exp(W[17] * (g - 3 + W[18]));
  const fuzz = (days) => days * DAY * (1 + (Math.random() - 0.5) * 0.1);

  function schedule(p0, g, now) {
    const p = { ...p0 }; p.reps += 1;
    if (p.state === 'new') {
      p.S = S0(g); p.D = D0(g); p.last = now;
      if (g === 4) { p.state = 'review'; p.due = now + fuzz(ivlFor(p.S)); return p; }
      p.state = 'learn'; p.step = g === 3 ? 1 : 0;
      p.due = now + (g === 1 ? LEARN_STEPS[0] : g === 2 ? (LEARN_STEPS[0] + LEARN_STEPS[1]) / 2 : LEARN_STEPS[1]) * MIN;
      return p;
    }
    if (p.state === 'learn' || p.state === 'relearn') {
      const steps = p.state === 'learn' ? LEARN_STEPS : RELEARN_STEPS; p.last = now;
      p.S = Math.max(0.1, sShort(p.S || S0(g), g));
      if (g === 1) { p.step = 0; p.due = now + steps[0] * MIN; return p; }
      if (g === 2) { p.due = now + steps[Math.min(p.step, steps.length - 1)] * 1.5 * MIN; return p; }
      if (g === 3 && p.step + 1 < steps.length) { p.step += 1; p.due = now + steps[p.step] * MIN; return p; }
      p.state = 'review'; p.step = 0; p.due = now + fuzz(ivlFor(p.S)); return p;
    }
    const t = Math.max(0.01, (now - (p0.last || now)) / DAY), R = retr(t, Math.max(p.S, 0.1)); p.last = now;
    p.D = nextD(p.D, g);
    if (g === 1) { p.S = Math.max(0.1, sForget(p.S, p.D, R)); p.lapses += 1; p.state = 'relearn'; p.step = 0; p.due = now + RELEARN_STEPS[0] * MIN; return p; }
    p.S = sRecall(p.S, p.D, R, g); p.due = now + fuzz(ivlFor(p.S)); return p;
  }
  function fmtIvl(ms) {
    const m = Math.round(ms / MIN);
    if (m < 60) return '<' + Math.max(1, m) + 'm'; if (m < 24 * 60) return Math.round(m / 60) + 'h';
    const d = Math.round(m / 60 / 24); if (d < 30) return d + 'd'; if (d < 365) return (d / 30).toFixed(1).replace('.0', '') + 'mo'; return (d / 365).toFixed(1).replace('.0', '') + 'y';
  }
  function migrateProgress(p) {
    if (p.S !== undefined) return p;
    const ease = p.ease || 2.5, ivl = p.ivl || 0;
    return { ...p, S: p.state === 'review' ? Math.max(0.5, ivl) : W[2], D: clamp(5 + (2.5 - ease) * 4, 1, 10), last: p.last || (p.due ? p.due - ivl * DAY : 0), suspended: !!p.suspended, flag: p.flag || '', leech: !!p.leech };
  }

  // ---------- session building ----------
  const active = (c) => !prog(c.id).suspended;
  function enabledCards(domainKey) { const keys = domainKey ? [domainKey] : settings.domains; return allCards().filter((c) => keys.includes(c.d) && active(c)); }
  function newToday() { return (stats[todayKey()] || {}).new || 0; }
  function counts(domainKey) {
    const now = Date.now(); let due = 0, learn = 0, fresh = 0, seen = 0, total = 0;
    enabledCards(domainKey).forEach((c) => { const p = prog(c.id); total++; if (p.state === 'new') fresh++; else { seen++; if (p.due <= now) { if (p.state === 'review') due++; else learn++; } } });
    const newAllowed = Math.max(0, settings.newPerDay - newToday());
    return { due, learn, fresh: Math.min(fresh, newAllowed), freshTotal: fresh, seen, total };
  }
  function buildQueue(domainKey, opts = {}) {
    const now = Date.now(); const cards = enabledCards(domainKey);
    const learning = [], review = [], fresh = [];
    cards.forEach((c) => { const p = prog(c.id); if (p.state === 'new') fresh.push(c); else if (p.state === 'review') { if (opts.cram || p.due <= now) review.push(c); } else if (opts.cram || p.due <= now + (opts.ahead ? LEARN_AHEAD : 0)) learning.push(c); });
    shuffle(review); shuffle(fresh); learning.sort((a, b) => prog(a.id).due - prog(b.id).due);
    if (opts.cram) return shuffle(learning.concat(review));
    const newAllowed = opts.ahead ? (opts.limit || 10) : (opts.limit ? opts.limit : Math.max(0, settings.newPerDay - newToday()));
    let picked = weightedPick(fresh, newAllowed * 3).filter((c) => !c.reverse || prog(c.parent).state !== 'new');
    if (settings.burySiblings) { const seenFam = new Set(); picked = picked.filter((c) => { if (!c.fam) return true; if (seenFam.has(c.fam)) return false; seenFam.add(c.fam); return true; }); }
    picked = picked.slice(0, newAllowed);
    let q = learning.concat(review.slice(0, settings.maxReviews));
    picked.forEach((c, i) => { const pos = Math.min(q.length, Math.floor((i + 1) * q.length / (picked.length + 1)) + i); q.splice(pos, 0, c); });
    if (opts.limit && !opts.ahead) q = q.slice(0, opts.limit);
    return q;
  }
  function weightedPick(cards, n) {
    if (cards.length <= n) return cards.slice();
    const byDom = {}; cards.forEach((c) => (byDom[c.d] = byDom[c.d] || []).push(c));
    const out = [], weights = Object.keys(byDom).map((k) => ({ k, w: DOMAIN_BY_KEY[k] ? DOMAIN_BY_KEY[k].weight : 5 }));
    let guard = 0;
    while (out.length < n && guard++ < 10000) { const totalW = weights.reduce((s, x) => s + (byDom[x.k].length ? x.w : 0), 0); if (!totalW) break; let r = Math.random() * totalW; for (const x of weights) { if (!byDom[x.k].length) continue; r -= x.w; if (r <= 0) { out.push(byDom[x.k].pop()); break; } } }
    return out;
  }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  // ---------- persistence ----------
  async function load() {
    const s = await DB.get('settings', 'main'); settings = { ...DEFAULTS, ...(s || {}) };
    (await DB.getAll('progress')).forEach((p) => (progress[p.id] = migrateProgress(p)));
    (await DB.getAll('overrides')).forEach((o) => (overrides[o.id] = o));
    (await DB.getAll('usercards')).forEach((c) => (userCards[c.id] = c));
    (await DB.getAll('stats')).forEach((s) => (stats[s.id] = s));
    (await DB.getAll('queue')).forEach((q) => (queue[q.id] = q));
    if (!settings.statsLocalDay) { const tk = todayKey(); for (const k of Object.keys(stats)) if (k >= tk) { delete stats[k]; await DB.del('stats', k); } settings.statsLocalDay = true; await DB.put('settings', settings); }
    invalidate();
  }
  const saveSettings = () => DB.put('settings', settings);
  async function bumpStats(isNew, delta = 1) { const k = todayKey(); stats[k] = stats[k] || { id: k, reviews: 0, new: 0 }; stats[k].reviews = Math.max(0, stats[k].reviews + delta); if (isNew) stats[k].new = Math.max(0, stats[k].new + delta); await DB.put('stats', stats[k]); }
  async function logReview(card, before, r) { await DB.put('log', { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), cardId: card.id, d: card.d, r, state: before.state, ts: Date.now() }); }

  // ---------- navigation ----------
  function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id)); window.scrollTo(0, 0); }
  let sheetZ = 20;
  function openSheet(id) { const el = $(id); el.style.zIndex = ++sheetZ; el.classList.add('active'); const b = el.querySelector('.body'); if (b) b.scrollTop = 0; }
  function closeSheet(id) { $(id).classList.remove('active'); }
  let toastT; function toast(msg, ms = 2200) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }

  // ---------- home ----------
  function renderHome() {
    const c = counts(); const parts = [];
    if (c.due) parts.push(`<em>${c.due}</em> ${c.due === 1 ? 'card' : 'cards'} due`);
    if (c.learn) parts.push(`<em>${c.learn}</em> still learning`);
    if (c.fresh) parts.push(`<em>${c.fresh}</em> new`);
    $('due-lead').innerHTML = parts.length ? parts.join(', ') + '.' : (c.freshTotal ? 'All caught up. New cards unlock tomorrow.' : 'All caught up.');
    const qn = Object.keys(queue).length; $('queue-note').classList.toggle('hidden', !qn);
    $('queue-note').innerHTML = qn ? `<b style="color:var(--accent)">${qn}</b> generated ${qn === 1 ? 'card is' : 'cards are'} waiting for your review.` : '';
    if (settings.examDate) { const days = Math.ceil((new Date(settings.examDate + 'T00:00') - Date.now()) / DAY); const unseen = allCards().filter((c) => active(c) && settings.domains.includes(c.d) && prog(c.id).state === 'new').length; const perDay = settings.newPerDay || 1; const need = Math.ceil(unseen / perDay); $('exam-note').classList.remove('hidden'); $('exam-note').innerHTML = days >= 0 ? `<b style="color:var(--accent)">${days}</b> days to the exam · ${unseen} unseen cards ≈ ${need} days at ${perDay}/day${need > days ? ' — raise new cards/day to finish in time' : ''}.` : 'Exam date has passed — update it in Settings.'; } else $('exam-note').classList.add('hidden');
    $('btn-start').disabled = !(c.due + c.learn + c.fresh);
    $('btn-start').textContent = (c.due + c.learn + c.fresh) ? `Start studying (${c.due + c.learn + c.fresh})` : 'Nothing due';
    const list = $('domain-list'); list.innerHTML = '';
    DOMAINS.forEach((d) => { const dc = counts(d.key), on = settings.domains.includes(d.key), b = document.createElement('button'); b.className = 'domain' + (on ? '' : ' off'); const pct = dc.total ? Math.round(100 * dc.seen / dc.total) : 0; b.innerHTML = `<span class="name">${d.name}</span><span class="due">${dc.due + dc.learn ? (dc.due + dc.learn) + ' due' : ''}</span><span class="meta">${d.weight}% of OITE · ${dc.seen}/${dc.total} seen${on ? '' : ' · paused'}</span><span class="meta"></span><span class="prog"><i style="width:${pct}%"></i></span>`; b.onclick = () => startSession(d.key); list.appendChild(b); });
  }

  // ---------- study ----------
  function startSession(domainKey, opts = {}) {
    const q = buildQueue(domainKey, opts);
    if (!q.length) { toast(opts.cram ? 'Nothing to cram in that selection — study some cards first.' : domainKey ? 'Nothing due in this domain — try Quick 10.' : 'Nothing due right now.'); return; }
    session = { queue: q, done: 0, total: q.length, undo: [], domain: domainKey || null, again: 0, misses: new Set(), cram: !!opts.cram };
    $('study-title').textContent = opts.cram ? 'Cram' : domainKey ? DOMAIN_BY_KEY[domainKey].name : (opts.limit ? 'Quick session' : 'Studying');
    $('done').classList.add('hidden'); $('cardwrap').classList.remove('hidden'); document.querySelector('#study .toolrow').classList.remove('hidden');
    show('study'); nextCard();
  }
  function nextCard() {
    const now = Date.now(); if (!session.queue.length) return finishSession();
    let idx = session.queue.findIndex((c) => { const p = prog(c.id); return p.state === 'new' || p.state === 'review' || p.due <= now || session.cram; }); if (idx < 0) idx = 0;
    current = cardById(session.queue[idx].id) || session.queue[idx]; session.queue.splice(idx, 1);
    revealed = false; renderCard(); $('study-progress').style.width = Math.round(100 * session.done / session.total) + '%';
  }
  function renderCard() {
    const c = current, p = prog(c.id), cz = isCloze(c);
    $('c-domain').innerHTML = `<b>${DOMAIN_BY_KEY[c.d]?.name || 'Custom'}</b>${c.user ? ' · yours' : ''}${c.reverse ? ' · reverse' : ''}${p.flag ? `<span class="flagpill">${FLAGS[p.flag] || 'Flagged'}</span>` : ''}${p.leech ? '<span class="flagpill">leech</span>' : ''}`;
    $('c-type').textContent = (TYPES[c.t] || '') + (p.state === 'new' ? ' · new' : p.state === 'review' ? '' : ' · learning');
    if (cz) { $('c-q').innerHTML = revealed ? clozeBack(c.q) : clozeFront(c.q); $('c-a').textContent = c.a || ''; } else { $('c-q').textContent = c.q; $('c-a').textContent = c.a; }
    $('c-a').style.display = $('c-a').textContent ? '' : 'none';
    const imgs = $('c-imgs'); imgs.innerHTML = ''; (c.images || []).forEach((im) => imgs.appendChild(imgEl(im)));
    $('c-edited').textContent = c.edited ? 'Edited by you' : '';
    $('c-reveal').classList.toggle('hidden', !revealed); $('c-hint').classList.toggle('hidden', revealed); $('showbar').classList.toggle('hidden', revealed); $('ratebar').classList.toggle('hidden', !revealed);
    if (revealed) { const now = Date.now(); [1, 2, 3, 4].forEach((r) => { $('iv' + r).textContent = fmtIvl(schedule(p, r, now).due - now); }); renderRelated(c, $('c-related'), $('c-related-list')); }
    $('btn-flag').classList.toggle('on', !!p.flag); $('btn-undo').style.visibility = session && session.undo.length ? 'visible' : 'hidden'; $('card').scrollTop = 0;
  }
  function reveal() { if (revealed) return; revealed = true; renderCard(); }
  async function rate(r) {
    if (!current || !revealed) return;
    const now = Date.now(), before = prog(current.id), isNew = before.state === 'new';
    const after = schedule(before, r, now);
    if (r === 1 && before.state === 'review' && after.lapses >= settings.leechThreshold && !after.leech) { after.leech = true; if (settings.leechAction === 'suspend') after.suspended = true; toast(`Leech: failed ${after.lapses} times — ${settings.leechAction === 'suspend' ? 'suspended. Rewrite it from Browse › Leeches.' : 'tagged.'}`, 4500); }
    session.undo.push({ card: current, before: progress[current.id] ? { ...progress[current.id] } : null, queue: session.queue.slice(), done: session.done, isNew }); if (session.undo.length > 20) session.undo.shift();
    progress[current.id] = after; await DB.put('progress', after); await bumpStats(isNew); await logReview(current, before, r);
    if (r === 1) { session.again++; session.misses.add(current.parent || current.id); }
    if (settings.burySiblings && current.fam) session.queue = session.queue.filter((c) => c.fam !== current.fam);
    if ((after.state === 'learn' || after.state === 'relearn') && !after.suspended) { session.queue.splice(Math.min(session.queue.length, 3), 0, current); session.total++; }
    session.done++; animate(r === 1 ? 'swipe-left' : 'swipe-right'); nextCard();
  }
  function animate(cls) { const el = $('card'); el.classList.add(cls); setTimeout(() => el.classList.remove(cls), 180); }
  async function undo() {
    if (!session || !session.undo.length) return; const u = session.undo.pop();
    if (u.before) { progress[u.card.id] = u.before; await DB.put('progress', u.before); } else { delete progress[u.card.id]; await DB.del('progress', u.card.id); }
    await bumpStats(u.isNew, -1); session.queue = u.queue; session.done = u.done; session.total = Math.max(session.total, u.queue.length + u.done + 1);
    if (current) session.queue.unshift(current); current = cardById(u.card.id) || u.card; revealed = false; renderCard(); toast('Rating undone');
  }
  function skip() { if (!current) return; session.queue.push(current); nextCard(); }
  async function setFlag(card, flag) { const p = prog(card.id); p.flag = flag; progress[card.id] = p; await DB.put('progress', p); }
  async function setSuspended(card, v) { const p = prog(card.id); p.suspended = v; if (!v) p.leech = false; progress[card.id] = p; await DB.put('progress', p); }
  function chooseFlag(card, after) {
    const keys = Object.keys(FLAGS), cur = prog(card.id).flag || '';
    const pick = prompt('Flag this card:\n' + keys.map((k, i) => `${i}: ${FLAGS[k]}`).join('\n'), String(keys.indexOf(cur)));
    if (pick === null) return; const k = keys[+pick]; if (k === undefined) return;
    setFlag(card, k).then(() => { toast(k ? 'Flagged: ' + FLAGS[k] : 'Flag removed'); after && after(); });
  }
  function finishSession() {
    $('cardwrap').classList.add('hidden'); $('ratebar').classList.add('hidden'); $('showbar').classList.add('hidden'); document.querySelector('#study .toolrow').classList.add('hidden');
    $('done').classList.remove('hidden'); $('done-summary').textContent = `${session.done} reviews · ${session.again} marked Again`;
    $('btn-explain').classList.toggle('hidden', !session.misses.size); $('study-progress').style.width = '100%'; current = null;
  }
  (function swipe() {
    const el = $('card'); let x0 = null, y0 = null, moved = false;
    el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; moved = false; }, { passive: true });
    el.addEventListener('touchmove', (e) => { if (x0 === null) return; const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0; if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) { moved = true; el.style.transform = `translateX(${dx * 0.35}px) rotate(${dx * 0.02}deg)`; } }, { passive: true });
    el.addEventListener('touchend', (e) => { const dx = (e.changedTouches[0].clientX - x0) || 0; el.style.transform = ''; x0 = null; if (e.target.closest('.related')) return; if (moved && Math.abs(dx) > 70) { if (!revealed) reveal(); else rate(dx > 0 ? 3 : 1); } else if (!moved) reveal(); });
  })();

  // ---------- related cards ----------
  const STOP = new Set(['what', 'which', 'with', 'from', 'that', 'this', 'after', 'before', 'most', 'common', 'treatment', 'fracture', 'fractures', 'injury', 'risk', 'factor', 'factors', 'type', 'stage', 'grade', 'classification', 'normal', 'and', 'the', 'for', 'when', 'who', 'where', 'rule', 'sign', 'test', 'first', 'second', 'patient', 'patients', 'definition', 'means', 'cause', 'causes', 'threshold', 'indication', 'indications']);
  function keywords(q) { return clozePlain(q).toLowerCase().replace(/[^a-z0-9\-' ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)); }
  function related(card) {
    const all = allCards(); const out = [];
    if (card.fam) all.forEach((c) => { if (c.id !== card.id && c.id !== card.parent && c.fam === card.fam && !c.reverse) out.push(c); });
    const kw = keywords(card.q); const scored = [];
    if (kw.length) all.forEach((c) => { if (c.id === card.id || c.reverse || c.d !== card.d || out.includes(c) || c.id === card.parent) return; const t = (clozePlain(c.q) + ' ' + c.a).toLowerCase(); let s = 0; kw.forEach((w) => { if (t.includes(w)) s += w.length; }); if (s >= 8) scored.push([s, c]); });
    scored.sort((a, b) => b[0] - a[0]);
    return out.slice(0, 8).concat(scored.slice(0, 4).map((x) => x[1])).slice(0, 8);
  }
  function renderRelated(card, wrap, list) {
    const rel = related(card); list.innerHTML = ''; wrap.classList.toggle('hidden', !rel.length);
    rel.forEach((c) => { const b = document.createElement('button'); b.innerHTML = `<b>${esc(clozePlain(c.q))}</b> — ${esc(clozePlain(c.a)).slice(0, 80)}`; b.onclick = (e) => { e.stopPropagation(); openPreview(c.id); }; list.appendChild(b); });
  }

  // ---------- browse ----------
  let browseFilter = null;
  function renderBrowse() {
    const chips = $('browse-chips'); chips.innerHTML = '';
    [{ key: null, name: 'All' }].concat(DOMAINS).concat([{ key: '__mine', name: 'Mine' }, { key: '__edited', name: 'Edited' }, { key: '__flag', name: 'Flagged' }, { key: '__susp', name: 'Suspended' }, { key: '__leech', name: 'Leeches' }, { key: '__cloze', name: 'Cloze' }]).forEach((d) => { const b = document.createElement('button'); b.className = 'chip' + (browseFilter === d.key ? ' on' : ''); b.textContent = d.name; b.onclick = () => { browseFilter = d.key; renderBrowse(); }; chips.appendChild(b); });
    const term = $('search').value.trim().toLowerCase(); let cards = allCards().filter((c) => !c.reverse);
    if (browseFilter === '__mine') cards = cards.filter((c) => c.user); else if (browseFilter === '__edited') cards = cards.filter((c) => c.edited);
    else if (browseFilter === '__flag') cards = cards.filter((c) => prog(c.id).flag); else if (browseFilter === '__susp') cards = cards.filter((c) => prog(c.id).suspended);
    else if (browseFilter === '__leech') cards = cards.filter((c) => prog(c.id).leech); else if (browseFilter === '__cloze') cards = cards.filter(isCloze);
    else if (browseFilter) cards = cards.filter((c) => c.d === browseFilter);
    if (term) cards = cards.filter((c) => (clozePlain(c.q) + ' ' + c.a).toLowerCase().includes(term));
    const list = $('browse-list'); list.innerHTML = ''; const now = Date.now();
    cards.slice(0, 300).forEach((c) => { const p = prog(c.id), b = document.createElement('button'); b.className = 'item'; const sched = p.suspended ? 'suspended' : p.state === 'new' ? 'new' : (p.due <= now ? 'due now' : 'due in ' + fmtIvl(p.due - now)); b.innerHTML = `<div class="iq">${isCloze(c) ? clozeFront(c.q) : esc(c.q)}</div><div class="im"><b>${DOMAIN_BY_KEY[c.d]?.name || 'Custom'}</b> · ${TYPES[c.t] || ''} · ${sched}${c.user ? ' · yours' : c.edited ? ' · edited' : ''}${p.flag ? ' · ' + FLAGS[p.flag] : ''}${p.leech ? ' · leech' : ''}</div>`; b.onclick = () => openPreview(c.id); list.appendChild(b); });
    if (!cards.length) list.innerHTML = '<p class="note">No cards match.</p>'; else if (cards.length > 300) list.insertAdjacentHTML('beforeend', `<p class="note">Showing 300 of ${cards.length}.</p>`);
  }
  function openPreview(id) {
    previewCard = cardById(id); if (!previewCard) return; const c = previewCard, p = prog(id), now = Date.now();
    $('p-meta').innerHTML = `<b style="color:var(--accent)">${DOMAIN_BY_KEY[c.d]?.name || 'Custom'}</b> · ${TYPES[c.t] || ''}${c.user ? ' · yours' : c.edited ? ' · edited by you' : ''}${c.reverse ? ' · reverse' : ''}${p.flag ? `<span class="flagpill">${FLAGS[p.flag]}</span>` : ''}${p.leech ? '<span class="flagpill">leech</span>' : ''}${p.suspended ? '<span class="flagpill">suspended</span>' : ''}`;
    if (isCloze(c)) { $('p-q').innerHTML = clozeBack(c.q); $('p-a').textContent = c.a || ''; } else { $('p-q').textContent = c.q; $('p-a').textContent = c.a; }
    const imgs = $('p-imgs'); imgs.innerHTML = ''; (c.images || []).forEach((im) => { const el = imgEl(im); (el.tagName === 'IMG' ? el : el.querySelector('img')).style.cssText = 'max-width:100%;border-radius:10px'; imgs.appendChild(el); });
    renderRelated(c, $('p-related'), $('p-related-list')); $('btn-p-suspend').textContent = p.suspended ? 'Unsuspend' : 'Suspend';
    $('p-sched').textContent = p.state === 'new' ? 'Not studied yet.' : `${p.reps} reviews · ${p.lapses} lapses · stability ${(+p.S || 0).toFixed(1)}d · difficulty ${(+p.D || 5).toFixed(1)}/10 · ${p.due <= now ? 'due now' : 'due in ' + fmtIvl(p.due - now)}`;
    openSheet('preview');
  }

  // ---------- edit ----------
  function openEdit(card, isNew) {
    editCard = { card, isNew }; editImages = (card.images || []).slice();
    $('edit-title').textContent = isNew ? 'New card' : 'Edit card';
    const sel = $('e-domain'); sel.innerHTML = DOMAINS.map((d) => `<option value="${d.key}">${d.name}</option>`).join(''); sel.value = card.d || 'trauma'; $('e-type').value = TYPES[card.t] ? card.t : 'management';
    $('edit-domain-field').classList.toggle('hidden', !(isNew || card.user)); $('edit-type-field').classList.toggle('hidden', !(isNew || card.user));
    $('e-q').value = card.q || ''; $('e-a').value = card.a || ''; $('e-img').value = '';
    $('btn-edit-revert').classList.toggle('hidden', !(card.edited && !card.user)); $('btn-edit-delete').classList.toggle('hidden', !card.user);
    renderThumbs(); openSheet('edit');
  }
  function renderThumbs() { const t = $('e-thumbs'); t.innerHTML = ''; editImages.forEach((src, i) => { const w = document.createElement('div'); w.className = 't'; const thumb = typeof src === 'string' ? src : (src.thumb || src.url); w.innerHTML = `<img src="${thumb}" alt=""><button class="x" aria-label="Remove image">×</button>`; w.querySelector('.x').onclick = () => { editImages.splice(i, 1); renderThumbs(); }; t.appendChild(w); }); }
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => { const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => { const max = 1200; let { width: w, height: h } = img; const s = Math.min(1, max / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s); const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url); resolve(cv.toDataURL('image/jpeg', 0.82)); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); }; img.src = url; });
  }
  async function saveEdit() {
    const q = $('e-q').value.trim(), a = $('e-a').value.trim(), t = $('e-type').value, cz = hasCloze(q);
    if (!q || (!a && !cz)) { toast('Both front and back are needed (cloze cards need {{c1::…}} in the front).'); return; }
    const { card, isNew } = editCard;
    if (isNew || card.user) { const id = isNew ? 'u_' + Date.now().toString(36) : card.id; const rec = { id, d: $('e-domain').value, t: cz ? 'cloze' : (t === 'cloze' ? 'management' : t), q, a, images: editImages, created: card.created || Date.now(), src: card.src }; userCards[id] = rec; await DB.put('usercards', rec); }
    else {
      const base = SEED_CARDS.find((c) => c.id === (card.parent || card.id)); const nq = card.reverse ? a : q, na = card.reverse ? q : a;
      const rec = { id: base.id, q: nq === base.q ? undefined : nq, a: na === base.a ? undefined : na, images: editImages };
      if (rec.q === undefined && rec.a === undefined && !editImages.length) { delete overrides[base.id]; await DB.del('overrides', base.id); } else { overrides[base.id] = rec; await DB.put('overrides', rec); }
    }
    invalidate(); closeSheet('edit'); afterEdit(isNew ? null : card.id); toast(isNew ? 'Card added' : 'Saved');
  }
  async function revertEdit() { const id = editCard.card.parent || editCard.card.id; delete overrides[id]; await DB.del('overrides', id); invalidate(); closeSheet('edit'); afterEdit(editCard.card.id); toast('Reverted'); }
  async function deleteUserCard() { const id = editCard.card.id; delete userCards[id]; await DB.del('usercards', id); delete progress[id]; await DB.del('progress', id); invalidate(); closeSheet('edit'); closeSheet('preview'); if (current && current.id === id) nextCard(); if ($('browse').classList.contains('active')) renderBrowse(); renderHome(); toast('Card deleted'); }
  function afterEdit(id) { if (current && (current.id === id || current.parent === id || id === null)) { const c = cardById(current.id); if (c) { current = c; renderCard(); } } if (previewCard && previewCard.id === id) openPreview(id); if ($('browse').classList.contains('active')) renderBrowse(); renderHome(); }

  // ---------- image search ----------
  let imgSource = 'commons', imgSel = null, gStart = 1;
  function cleanQuery(q) { return clozePlain(q).replace(/[?:"“”]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' '); }
  async function searchCommons(q) {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=30&gsrsearch=' + encodeURIComponent(q + ' filetype:bitmap') + '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=800&format=json&origin=*';
    const j = await (await fetch(u)).json();
    return Object.values(j.query?.pages || {}).map((p) => { const ii = (p.imageinfo || [])[0] || {}, m = ii.extmetadata || {}; const artist = (m.Artist?.value || '').replace(/<[^>]+>/g, '').trim(), lic = m.LicenseShortName?.value || ''; return { url: ii.thumburl || ii.url, thumb: ii.thumburl, full: ii.url, title: (p.title || '').replace(/^File:/, ''), page: ii.descriptionurl, credit: [artist, lic, 'Wikimedia Commons'].filter(Boolean).join(' · ') }; }).filter((x) => x.url && /\.(jpe?g|png|gif|webp)$/i.test(x.full || x.url));
  }
  async function searchGoogle(q, start = 1) {
    if (!settings.gKey || !settings.gCx) throw new Error('Add a Google API key and Search Engine ID in Settings, or use "Open Google Images in Safari".');
    const u = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(settings.gKey)}&cx=${encodeURIComponent(settings.gCx)}&searchType=image&num=10&start=${start}&safe=active&q=${encodeURIComponent(q)}`;
    const r = await fetch(u), j = await r.json(); if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
    return (j.items || []).map((it) => ({ url: it.link, thumb: it.image?.thumbnailLink, title: it.title, page: it.image?.contextLink, credit: it.displayLink ? 'Source: ' + it.displayLink : '' }));
  }
  async function runImageSearch(more) {
    const q = cleanQuery($('img-q').value); if (!q) return; const box = $('img-results');
    if (!more) { box.innerHTML = '<p class="note">Searching…</p>'; gStart = 1; }
    try {
      const res = imgSource === 'google' ? await searchGoogle(q, gStart) : await searchCommons(q);
      if (!more) box.innerHTML = ''; let grid = box.querySelector('.imggrid'); if (!grid) { grid = document.createElement('div'); grid.className = 'imggrid'; box.appendChild(grid); }
      res.forEach((im) => { const b = document.createElement('button'); b.innerHTML = `<img src="${im.thumb || im.url}" loading="lazy" alt=""><div class="cap">${esc(im.title || '')}</div>`; b.onclick = () => { imgSel = im; $('imgp-img').src = im.url; $('imgp-meta').textContent = (im.title || '') + (im.credit ? ' — ' + im.credit : ''); openSheet('imgpreview'); }; grid.appendChild(b); });
      const old = box.querySelector('.morebtn'); old && old.remove();
      if (!res.length && !more) box.innerHTML = '<p class="note">No images found. Try fewer or different words.</p>';
      if (imgSource === 'google' && res.length === 10) { gStart += 10; const mb = document.createElement('button'); mb.className = 'secondary morebtn'; mb.style.cssText = 'display:block;width:100%;margin-top:12px;text-align:center'; mb.textContent = 'More results'; mb.onclick = () => runImageSearch(true); box.appendChild(mb); }
    } catch (e) { box.innerHTML = `<p class="note warn">${esc(e.message)}</p>`; }
  }
  async function pasteImage() {
    try { if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('unsupported'); const items = await navigator.clipboard.read(); let found = false;
      for (const it of items) { const type = it.types.find((t) => t.startsWith('image/')); if (!type) continue; editImages.push(await fileToDataURL(await it.getType(type))); found = true; }
      if (!found) { toast('No image on the clipboard. Long-press a picture in Safari and choose Copy first.', 4000); return; } renderThumbs(); toast('Image pasted — tap Save to keep it');
    } catch (e) { toast('Paste not available — save the picture to Photos, then use "Add from Photos".', 4500); }
  }
  async function addSelectedImage() { if (!imgSel) return; const rec = { url: imgSel.url, thumb: imgSel.thumb || '', credit: imgSel.credit || '', page: imgSel.page || '', title: imgSel.title || '' }; editImages.push(rec); renderThumbs(); try { const c = await caches.open('orthodeck-images'); for (const u of [rec.url, rec.thumb].filter(Boolean)) { const r = await fetch(u, { mode: 'no-cors' }); await c.put(u, r); } } catch (e) {} closeSheet('imgpreview'); closeSheet('imgsearch'); toast('Image added — tap Save to keep it'); }

  // ---------- Anthropic helper ----------
  async function claude(system, messages, maxTokens = 1000) {
    if (!settings.apiKey) throw new Error('Add your Anthropic API key in Settings first.');
    const resp = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: settings.model || DEFAULTS.model, max_tokens: maxTokens, system, messages }) });
    const data = await resp.json(); if (!resp.ok) throw new Error(data.error?.message || ('HTTP ' + resp.status));
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  }

  // ---------- chat ----------
  let chatHistory = [];
  async function openChat(card) { chatCard = card; const saved = await DB.get('chats', card.id); chatHistory = saved ? saved.messages : []; renderChat(); openSheet('chat'); if (!settings.apiKey) toast('Add your Anthropic API key in Settings to use chat.', 3500); }
  function renderChat() { const l = $('chat-list'); l.innerHTML = ''; const sys = document.createElement('div'); sys.className = 'msg sys'; sys.textContent = 'Answers are grounded in this card and may be wrong. Verify management details against primary sources.'; l.appendChild(sys); chatHistory.forEach((m) => { const d = document.createElement('div'); d.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai'); d.textContent = m.content; l.appendChild(d); }); l.scrollTop = l.scrollHeight; }
  const systemPrompt = (card) => `You are a study tutor inside OrthoDeck, an orthopaedic surgery board-prep flashcard app (OITE / ABOS Part I level). The user is looking at one flashcard and reads your answers on a phone screen, so be concise: short paragraphs, plain text, no markdown headers.\n\nGround everything in the card below. Explain mechanism, compare against plausible wrong answers, connect related classification systems, offer memory hooks when asked. If the card looks outdated or you are unsure, say so. This is a study aid, not a clinical reference: when you give management details, end with a one-line reminder to verify against primary sources. Do not invent citations.\n\nDomain: ${DOMAIN_BY_KEY[card.d]?.name || 'Custom'}\nCard type: ${TYPES[card.t] || 'general'}\nFront: ${clozePlain(card.q)}\nBack: ${card.a}`;
  async function sendChat(text) {
    text = (text || $('chat-text').value).trim(); if (!text || !chatCard) return; if (!settings.apiKey) { toast('Add your Anthropic API key in Settings first.'); return; }
    $('chat-text').value = ''; $('chat-text').style.height = 'auto'; chatHistory.push({ role: 'user', content: text }); renderChat();
    const thinking = document.createElement('div'); thinking.className = 'msg ai'; thinking.textContent = '…'; $('chat-list').appendChild(thinking);
    try { const reply = await claude(systemPrompt(chatCard), chatHistory.slice(-12), 800); chatHistory.push({ role: 'assistant', content: reply || '(no reply)' }); await DB.put('chats', { id: chatCard.id, messages: chatHistory }); }
    catch (e) { chatHistory.pop(); renderChat(); $('chat-text').value = text; toast(/Failed to fetch/i.test(e.message) ? 'No connection. Chat needs a signal; studying does not.' : 'Chat failed: ' + e.message, 4500); return; }
    renderChat();
  }

  // ---------- explain my misses ----------
  async function explainMisses() {
    if (!session || !session.misses.size) return;
    const cards = [...session.misses].map((id) => cardById(id)).filter(Boolean);
    $('explain-text').textContent = 'Thinking about ' + cards.length + ' cards…'; openSheet('explain');
    const list = cards.map((c, i) => `${i + 1}. [${DOMAIN_BY_KEY[c.d]?.name}] Q: ${clozePlain(c.q)} — A: ${clozePlain(c.a) || '(cloze answer above)'}`).join('\n');
    const sys = `You are a tutor for orthopaedic surgery residents preparing for the OITE. The user just failed these flashcards in one session. Write for a phone screen: plain text, no markdown, short paragraphs, simple numbered lines.

1) Group the misses into 2–5 underlying concepts (e.g. "confusing the two vertical-shear classifications", "root-level anatomy"). Name each group in one line.
2) For each group, explain in 2–4 sentences the idea that, once understood, makes the individual facts stick — mechanism, anatomy, or the logic behind the threshold. Point out specific confusions between the cards where relevant.
3) Give one memory hook per group if a natural one exists (don't force it).
4) End with a "5-minute reading" line per group: what to look up and where (textbook chapter/section or a landmark paper by name), no URLs.
Do not repeat the cards verbatim. If anything on a card looks wrong, say so plainly.`;
    try { $('explain-text').textContent = await claude(sys, [{ role: 'user', content: 'Missed cards:\n' + list }], 1500); }
    catch (e) { $('explain-text').textContent = 'Could not get an explanation: ' + e.message; }
  }

  // ---------- import: PDF/text → cards → queue ----------
  let pdfPages = null;
  const IMPORT_SYSTEM = (domainKey, density, cloze) => `You write orthopaedic board-review flashcards (OITE / ABOS Part I level) from source text supplied by the user. Return ONLY a JSON array, no prose, no markdown fences.

Each element is either {"d": domain key, "t": card type, "q": front, "a": back} or, for a cloze card, {"d": domain key, "t": "cloze", "q": sentence with the answer wrapped as {{c1::answer}}, "a": ""}.
Domain keys: ${DOMAINS.map((x) => x.key + ' = ' + x.name).join(', ')}.${domainKey === 'auto' ? ' Choose the best domain per card.' : ' Use "' + domainKey + '" for every card.'}
Card types: classification, anatomy, diagnosis, management${cloze ? ', cloze' : ''}.

Rules — GRANULAR cards:
- ONE fact per card. Never bundle. A classification system becomes one card per grade/type. A list becomes one card per item.
- Back = a phrase, not a paragraph: 3–12 words, hard maximum 20. No explanations, no second sentence.
- Front = a specific prompt with exactly one answer.
${cloze ? '- Use cloze cards for sentences that carry one key term or number ("The {{c1::deep deltoid}} is the primary restraint to lateral talar shift"). One cloze per card. Aim for roughly a third of cards as cloze when the text is list-heavy.' : ''}
- Use every number, threshold, eponym, percentage, nerve, and treatment decision — these are the testable facts. Aim for ${density === 'light' ? 'only clearly high-yield facts' : density === 'normal' ? 'roughly 20–40 cards per 1,000 words of dense text' : 'roughly 40–70 cards per 1,000 words of dense text — extract everything testable'}.
- Write in your own words; do not copy sentences or tables.
- Skip history/acknowledgements, references, figure captions, and page furniture.
- If the text has no board-relevant content, return [].`;
  function chunkText(text, words = 3000) { const w = text.split(/\s+/).filter(Boolean), out = []; for (let i = 0; i < w.length; i += words) out.push(w.slice(i, i + words).join(' ')); return out; }
  async function readPdf(file, onPage) {
    const pdfjs = await import('./vendor/pdf.min.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise; const pages = [];
    for (let i = 1; i <= doc.numPages; i++) { const c = await (await doc.getPage(i)).getTextContent(); pages.push(c.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('')); onPage && onPage(i, doc.numPages); }
    return pages;
  }
  function applyRange() { if (!pdfPages) return; const a = clamp(+$('i-from').value || 1, 1, pdfPages.length), b = clamp(+$('i-to').value || pdfPages.length, a, pdfPages.length); $('i-from').value = a; $('i-to').value = b; $('i-text').value = pdfPages.slice(a - 1, b).join('\n\n'); updateWords(); }
  function updateWords() { const n = $('i-text').value.split(/\s+/).filter(Boolean).length; $('i-words').textContent = n ? `${n.toLocaleString()} words ≈ ${Math.ceil(n / 3000)} requests` : ''; }
  function parseCards(raw) { let t = raw.replace(/```json|```/g, '').trim(); const a = t.indexOf('['), b = t.lastIndexOf(']'); if (a < 0 || b < 0) return []; try { const arr = JSON.parse(t.slice(a, b + 1)); return Array.isArray(arr) ? arr : []; } catch (e) { return []; } }
  const norm = (s) => clozePlain(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  function findDuplicate(q) { const n = norm(q); if (!n) return null; for (const c of allCards()) { if (c.reverse) continue; const m = norm(c.q); if (m === n) return c; if (n.length > 20 && (m.includes(n) || n.includes(m)) && Math.abs(m.length - n.length) < 12) return c; } return null; }
  async function startImport() {
    if (!settings.apiKey) { toast('Add your Anthropic API key in Settings first.', 3500); return; }
    const text = $('i-text').value.trim(); if (!text) { toast('Choose a PDF or paste some text.'); return; }
    const domainKey = $('i-domain').value, density = $('i-density').value, cloze = $('i-cloze').checked, source = ($('i-file').files[0] && $('i-file').files[0].name) || ('Pasted text ' + todayKey());
    $('import-setup').classList.add('hidden'); $('import-progress').classList.remove('hidden'); $('import-review').classList.add('hidden');
    importJob = { cancel: false }; const lead = $('i-progress-lead'), bar = $('i-progress-bar'), note = $('i-progress-note');
    try {
      const chunks = chunkText(text); let made = 0, dups = 0;
      for (let i = 0; i < chunks.length; i++) {
        if (importJob.cancel) break; lead.textContent = `Writing cards… ${made} so far`; note.textContent = `Section ${i + 1} of ${chunks.length}`; bar.style.width = Math.round(100 * i / chunks.length) + '%';
        let cards = []; try { cards = parseCards(await claude(IMPORT_SYSTEM(domainKey, density, cloze), [{ role: 'user', content: 'SOURCE TEXT:\n\n' + chunks[i] }], 8000)); } catch (e) { toast('Section ' + (i + 1) + ' failed: ' + e.message, 4000); continue; }
        for (const c of cards) { if (!c || !c.q) continue; const isCz = c.t === 'cloze' || hasCloze(c.q); if (!isCz && !c.a) continue;
          const dup = findDuplicate(c.q); const rec = { id: 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6), d: DOMAIN_BY_KEY[c.d] ? c.d : (domainKey !== 'auto' ? domainKey : 'trauma'), t: isCz ? 'cloze' : (TYPES[c.t] && c.t !== 'cloze' ? c.t : 'management'), q: String(c.q).trim(), a: String(c.a || '').trim(), src: source, created: Date.now(), dup: dup ? clozePlain(dup.q) : '' };
          if (dup) dups++; queue[rec.id] = rec; await DB.put('queue', rec); made++; }
      }
      bar.style.width = '100%'; toast(made ? `${made} cards ready for review${dups ? ` (${dups} look like duplicates)` : ''}` : 'No cards were generated.', 4000);
    } catch (e) { toast('Import failed: ' + e.message, 5000); }
    importJob = null; $('i-file').value = ''; $('i-text').value = ''; pdfPages = null; $('i-pages').classList.add('hidden'); $('i-status').textContent = ''; updateWords(); renderImport();
  }
  function renderImport() {
    const ids = Object.keys(queue); $('import-progress').classList.add('hidden'); $('import-setup').classList.toggle('hidden', !!ids.length); $('import-review').classList.toggle('hidden', !ids.length);
    if ($('i-domain').options.length <= 1) DOMAINS.forEach((d) => { const o = document.createElement('option'); o.value = d.key; o.textContent = d.name; $('i-domain').appendChild(o); });
    if (!ids.length) return;
    $('i-review-lead').innerHTML = `<em>${ids.length}</em> ${ids.length === 1 ? 'card' : 'cards'} to review. Tap one to edit, accept, or discard.`;
    const list = $('i-queue'); list.innerHTML = '';
    ids.map((id) => queue[id]).sort((a, b) => a.created - b.created).forEach((c) => { const b = document.createElement('button'); b.className = 'item'; b.innerHTML = `<div class="iq">${isCloze(c) ? clozeFront(c.q) : esc(c.q)}</div><div class="im"><b>${DOMAIN_BY_KEY[c.d]?.name}</b> · ${TYPES[c.t]} · from ${esc(c.src)}${c.dup ? ' · <span style="color:var(--hard)">possible duplicate</span>' : ''}</div>`; b.onclick = () => openQueueCard(c.id); list.appendChild(b); });
  }
  let qCur = null;
  function openQueueCard(id) { qCur = queue[id]; if (!qCur) return; const sel = $('q-domain'); sel.innerHTML = DOMAINS.map((d) => `<option value="${d.key}">${d.name}</option>`).join(''); sel.value = qCur.d; $('q-q').value = qCur.q; $('q-a').value = qCur.a; $('q-src').textContent = 'Generated from ' + qCur.src + '. Check it against the source before accepting.'; $('q-dup').classList.toggle('hidden', !qCur.dup); $('q-dup').textContent = qCur.dup ? 'Looks like an existing card: “' + qCur.dup + '”. Discard unless it adds something.' : ''; openSheet('qcard'); }
  async function acceptQueueCard(id, edits) { const c = queue[id]; if (!c) return; const q = edits?.q || c.q; const rec = { id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), d: edits?.d || c.d, t: hasCloze(q) ? 'cloze' : c.t, q, a: edits?.a ?? c.a, images: [], src: c.src, created: Date.now() }; userCards[rec.id] = rec; await DB.put('usercards', rec); delete queue[id]; await DB.del('queue', id); invalidate(); }
  async function discardQueueCard(id) { delete queue[id]; await DB.del('queue', id); }
  function nextQueueId(after) { const ids = Object.keys(queue).sort((a, b) => queue[a].created - queue[b].created); const i = ids.indexOf(after); return ids[(i + 1) % ids.length] || null; }

  // ---------- deck sharing ----------
  function renderDeckSelect() { const sel = $('s-deck'); sel.innerHTML = '<option value="__mine">My own cards</option><option value="__edited">My edited built-in cards</option>' + DOMAINS.map((d) => `<option value="${d.key}">${d.name} (built-in + mine)</option>`).join(''); }
  async function exportDeck() {
    const key = $('s-deck').value; let cards = allCards().filter((c) => !c.reverse);
    if (key === '__mine') cards = cards.filter((c) => c.user); else if (key === '__edited') cards = cards.filter((c) => c.edited); else cards = cards.filter((c) => c.d === key);
    if (!cards.length) { toast('Nothing to export in that selection.'); return; }
    const deck = { app: 'orthodeck-deck', version: APP_VERSION, name: $('s-deck').selectedOptions[0].textContent, exported: new Date().toISOString(), cards: cards.map((c) => ({ d: c.d, t: c.t, q: c.q, a: c.a, images: (c.images || []).filter((im) => typeof im !== 'string' || im.length < 400000), src: c.src || '' })) };
    const blob = new Blob([JSON.stringify(deck)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `orthodeck-${key.replace('__', '')}-${todayKey()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast(`${cards.length} cards exported`);
  }
  async function importDeck(file) {
    try { const data = JSON.parse(await file.text()); if (data.app !== 'orthodeck-deck' || !Array.isArray(data.cards)) throw new Error('Not an OrthoDeck deck file');
      let added = 0, skipped = 0; for (const c of data.cards) { if (!c.q || (!c.a && !hasCloze(c.q))) continue; if (findDuplicate(c.q)) { skipped++; continue; } const rec = { id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), d: DOMAIN_BY_KEY[c.d] ? c.d : 'trauma', t: TYPES[c.t] ? c.t : 'management', q: c.q, a: c.a || '', images: c.images || [], src: 'deck:' + (data.name || file.name), created: Date.now() }; userCards[rec.id] = rec; await DB.put('usercards', rec); added++; invalidate(); }
      toast(`Deck imported: ${added} cards added, ${skipped} duplicates skipped`, 4000); renderSettings(); renderHome();
    } catch (e) { toast('Import failed: ' + e.message, 4000); }
  }

  // ---------- stats ----------
  async function renderStats() {
    const log = await DB.getAll('log'); const all = allCards(); const now = Date.now();
    const seen = all.filter((c) => prog(c.id).state !== 'new'), mastered = all.filter((c) => { const p = prog(c.id); return p.state === 'review' && p.S >= 21; });
    const last30 = log.filter((l) => now - l.ts < 30 * DAY); const revs = last30.filter((l) => l.state === 'review' || l.state === 'relearn');
    const retention = revs.length ? Math.round(100 * revs.filter((l) => l.r > 1).length / revs.length) : null;
    let streak = 0; for (let i = 0; i < 400; i++) { const k = todayKey(-i); if ((stats[k] || {}).reviews > 0) streak++; else if (i > 0) break; }
    $('stat-grid').innerHTML = [[retention === null ? '—' : retention + '%', 'retention, last 30 days'], [mastered.length.toLocaleString(), 'cards mastered (stability ≥ 21d)'], [seen.length.toLocaleString() + ' / ' + all.length.toLocaleString(), 'cards seen'], [streak + (streak === 1 ? ' day' : ' days'), 'streak']].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
    const bars = $('bars'); bars.innerHTML = ''; const days = []; for (let i = 13; i >= 0; i--) days.push((stats[todayKey(-i)] || {}).reviews || 0); const mx = Math.max(1, ...days);
    days.forEach((n, i) => { const b = document.createElement('i'); b.style.height = Math.max(2, Math.round(100 * n / mx)) + '%'; b.title = n + ' reviews'; if (i === 13) b.className = 'today'; bars.appendChild(b); }); $('bars-l0').textContent = '13 days ago';
    const fc = $('forecast'); fc.innerHTML = ''; const f = new Array(7).fill(0); all.forEach((c) => { const p = prog(c.id); if (p.suspended || p.state !== 'review') return; const d = Math.floor((p.due - now) / DAY); if (d >= 0 && d < 7) f[d]++; }); const fmx = Math.max(1, ...f);
    f.forEach((n) => { const b = document.createElement('i'); b.style.height = Math.max(2, Math.round(100 * n / fmx)) + '%'; b.title = n + ' due'; fc.appendChild(b); }); $('forecast-note').textContent = `${f.reduce((a, b) => a + b, 0)} reviews due over the next week; ${f[0]} tomorrow.`;
    const rows = DOMAINS.map((d) => { const cards = all.filter((c) => c.d === d.key && !prog(c.id).suspended); const s = cards.filter((c) => prog(c.id).state !== 'new').length; const m = cards.filter((c) => { const p = prog(c.id); return p.state === 'review' && p.S >= 21; }).length; const lg = last30.filter((l) => l.d === d.key && (l.state === 'review' || l.state === 'relearn')); const acc = lg.length >= 5 ? lg.filter((l) => l.r > 1).length / lg.length : null; const coverage = cards.length ? s / cards.length : 0; const mastery = cards.length ? m / cards.length : 0; const gap = d.weight * (1 - (0.5 * mastery + 0.5 * (acc ?? mastery))); return { d, acc, coverage, gap }; }).sort((a, b) => b.gap - a.gap);
    const heat = $('heat'); heat.innerHTML = '<span class="h">Domain</span><span class="h">Weight</span><span class="h">Seen</span><span class="h">Accuracy</span><span class="h">Priority</span>'; const gmax = Math.max(...rows.map((r) => r.gap), 1);
    rows.forEach((r) => { const accTxt = r.acc === null ? '—' : Math.round(100 * r.acc) + '%'; const col = r.acc === null ? 'var(--muted)' : r.acc >= 0.9 ? 'var(--good)' : r.acc >= 0.8 ? 'var(--hard)' : 'var(--again)'; heat.insertAdjacentHTML('beforeend', `<span>${r.d.name}</span><span style="color:var(--muted)">${r.d.weight}%</span><span style="color:var(--muted)">${Math.round(100 * r.coverage)}%</span><span style="color:${col};font-weight:600">${accTxt}</span><span class="p"><i style="width:${Math.round(100 * r.gap / gmax)}%;background:${col}"></i></span>`); });
    const leeches = all.filter((c) => prog(c.id).leech).length, flags = all.filter((c) => prog(c.id).flag).length, susp = all.filter((c) => prog(c.id).suspended).length;
    $('leech-note').textContent = `${leeches} leech${leeches === 1 ? '' : 'es'} (failed ≥ ${settings.leechThreshold} times), ${flags} flagged, ${susp} suspended.`;
  }

  // ---------- settings ----------
  function renderSettings() {
    $('s-new').value = settings.newPerDay; $('s-max').value = settings.maxReviews; $('s-key').value = settings.apiKey; $('s-model').value = settings.model; $('s-gkey').value = settings.gKey || ''; $('s-gcx').value = settings.gCx || ''; $('s-daystart').value = String(settings.dayStart ?? 4);
    $('s-retention').value = String(settings.retention); $('s-exam').value = settings.examDate || ''; $('s-bury').checked = !!settings.burySiblings; $('s-reverse').checked = !!settings.reverse; $('s-leech').value = settings.leechThreshold; $('s-leechaction').value = settings.leechAction;
    const d = $('s-domains'); d.innerHTML = '';
    DOMAINS.forEach((dm) => { const l = document.createElement('label'); l.className = 'toggle'; l.innerHTML = `<span>${dm.name} <span style="color:var(--muted);font-size:13px">${dm.weight}%</span></span><input type="checkbox" ${settings.domains.includes(dm.key) ? 'checked' : ''}>`; l.querySelector('input').onchange = (e) => { settings.domains = DOMAINS.map((x) => x.key).filter((k) => k === dm.key ? e.target.checked : settings.domains.includes(k)); saveSettings(); }; d.appendChild(l); });
    renderDeckSelect();
    $('k-seed').textContent = SEED_CARDS.length; $('k-user').textContent = Object.keys(userCards).length; $('k-edited').textContent = Object.keys(overrides).length; $('k-reviews').textContent = Object.values(stats).reduce((s, x) => s + (x.reviews || 0), 0);
    $('about-text').textContent = `OrthoDeck ${APP_VERSION}. Seed deck weighted to the AAOS OITE blueprint. Scheduler: FSRS-5 with default parameters and 1 min / 10 min learning steps; intervals come from your target retention. Cards are one fact each. Built-in text is a starting point written for study, not a clinical reference.`;
  }
  function saveSettingsFromUI() {
    settings.newPerDay = Math.max(0, +$('s-new').value || 0); settings.maxReviews = Math.max(5, +$('s-max').value || 200); settings.apiKey = $('s-key').value.trim(); settings.model = $('s-model').value.trim() || DEFAULTS.model; settings.gKey = $('s-gkey').value.trim(); settings.gCx = $('s-gcx').value.trim(); settings.dayStart = +$('s-daystart').value;
    settings.retention = +$('s-retention').value; settings.examDate = $('s-exam').value; settings.burySiblings = $('s-bury').checked; const rev = $('s-reverse').checked; if (rev !== settings.reverse) { settings.reverse = rev; invalidate(); } settings.leechThreshold = Math.max(3, +$('s-leech').value || 8); settings.leechAction = $('s-leechaction').value;
    saveSettings();
  }
  async function exportBackup() { const data = { app: 'orthodeck', version: APP_VERSION, exported: new Date().toISOString(), progress: Object.values(progress), overrides: Object.values(overrides), usercards: Object.values(userCards), chats: await DB.getAll('chats'), stats: Object.values(stats), queue: Object.values(queue), log: await DB.getAll('log'), settings: { ...settings, apiKey: '', gKey: '' } }; const blob = new Blob([JSON.stringify(data)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `orthodeck-backup-${todayKey()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
  async function importBackup(file) { try { const data = JSON.parse(await file.text()); if (data.app !== 'orthodeck') throw new Error('Not an OrthoDeck backup'); await DB.putMany('progress', data.progress || []); await DB.putMany('overrides', data.overrides || []); await DB.putMany('usercards', data.usercards || []); await DB.putMany('chats', data.chats || []); await DB.putMany('stats', data.stats || []); await DB.putMany('queue', data.queue || []); await DB.putMany('log', data.log || []); if (data.settings) { settings = { ...settings, ...data.settings, apiKey: settings.apiKey, gKey: settings.gKey }; await saveSettings(); } progress = {}; overrides = {}; userCards = {}; stats = {}; queue = {}; await load(); renderSettings(); renderHome(); toast('Backup restored'); } catch (e) { toast('Import failed: ' + e.message, 4000); } }

  // ---------- wiring ----------
  function wire() {
    $('btn-start').onclick = () => startSession(null);
    $('btn-quick').onclick = () => startSession(null, { limit: 10, ahead: true });
    $('btn-cram').onclick = () => { const keys = DOMAINS.map((d, i) => `${i}: ${d.name}`).join('\n'); const pick = prompt('Cram which domain? Ignores scheduling and shows every card you have already seen.\n' + keys + '\nA: all enabled domains', 'A'); if (pick === null) return; const all = pick.trim().toUpperCase() === 'A'; const d = all ? null : DOMAINS[+pick]?.key; if (!all && !d) return; startSession(d, { cram: true }); };
    $('btn-browse').onclick = () => { show('browse'); renderBrowse(); };
    $('btn-settings').onclick = () => { show('settings'); renderSettings(); };
    $('btn-stats').onclick = () => { show('stats'); renderStats(); };
    $('btn-stats-back').onclick = () => { show('home'); renderHome(); };
    $('btn-view-leeches').onclick = () => { browseFilter = '__leech'; show('browse'); renderBrowse(); };
    $('btn-view-flags').onclick = () => { browseFilter = '__flag'; show('browse'); renderBrowse(); };
    $('btn-settings-back').onclick = () => { saveSettingsFromUI(); show('home'); renderHome(); };
    $('btn-browse-back').onclick = () => { show('home'); renderHome(); };
    $('btn-study-close').onclick = () => { session = null; current = null; show('home'); renderHome(); };
    $('btn-show').onclick = reveal; $('btn-undo').onclick = undo; $('btn-skip').onclick = skip;
    $('btn-flag').onclick = () => current && chooseFlag(current, renderCard);
    $('btn-suspend').onclick = async () => { if (!current) return; await setSuspended(current, true); toast('Suspended — unsuspend from Browse'); nextCard(); };
    document.querySelectorAll('#ratebar button').forEach((b) => (b.onclick = () => rate(+b.dataset.r)));
    $('btn-done-home').onclick = () => { session = null; show('home'); renderHome(); };
    $('btn-done-more').onclick = () => startSession(session ? session.domain : null, { limit: 10, ahead: true });
    $('btn-explain').onclick = explainMisses; $('btn-explain-close').onclick = () => closeSheet('explain');
    $('btn-edit').onclick = () => current && openEdit(current, false);
    $('btn-chat').onclick = () => current && openChat(current);
    $('btn-new-card').onclick = () => openEdit({ d: browseFilter && !browseFilter.startsWith('__') ? browseFilter : 'trauma', t: 'management', q: '', a: '', images: [] }, true);
    $('search').oninput = renderBrowse;
    $('btn-preview-close').onclick = () => closeSheet('preview');
    $('btn-p-edit').onclick = () => previewCard && openEdit(previewCard, false);
    $('btn-p-chat').onclick = () => previewCard && openChat(previewCard);
    $('btn-p-flag').onclick = () => previewCard && chooseFlag(previewCard, () => openPreview(previewCard.id));
    $('btn-p-suspend').onclick = async () => { if (!previewCard) return; const was = prog(previewCard.id).suspended; await setSuspended(previewCard, !was); toast(was ? 'Back in rotation' : 'Suspended'); openPreview(previewCard.id); if ($('browse').classList.contains('active')) renderBrowse(); };
    $('btn-p-study').onclick = () => { if (!previewCard) return; closeSheet('preview'); session = { queue: [previewCard], done: 0, total: 1, undo: [], domain: null, again: 0, misses: new Set(), cram: true }; $('study-title').textContent = 'Single card'; $('done').classList.add('hidden'); $('cardwrap').classList.remove('hidden'); document.querySelector('#study .toolrow').classList.remove('hidden'); show('study'); nextCard(); };
    $('btn-p-reset').onclick = async () => { if (!previewCard || !confirm('Reset progress on this card?')) return; delete progress[previewCard.id]; await DB.del('progress', previewCard.id); openPreview(previewCard.id); if ($('browse').classList.contains('active')) renderBrowse(); };
    $('btn-edit-cancel').onclick = () => closeSheet('edit'); $('btn-edit-save').onclick = saveEdit;
    $('btn-edit-revert').onclick = () => confirm('Discard your edits and images for this card?') && revertEdit();
    $('btn-edit-delete').onclick = () => confirm('Delete this card permanently?') && deleteUserCard();
    $('e-img').onchange = async (e) => { for (const f of e.target.files) { try { editImages.push(await fileToDataURL(f)); } catch (err) { toast(err.message); } } renderThumbs(); };
    $('btn-e-paste').onclick = pasteImage; $('btn-img-search').onclick = () => { if (!editCard) return; $('img-q').value = cleanQuery($('e-q').value || editCard.card.q || ''); $('img-results').innerHTML = '<p class="note">Tap Search, or change the words first.</p>'; openSheet('imgsearch'); };
    $('btn-img-back').onclick = () => closeSheet('imgsearch'); $('btn-img-go').onclick = () => runImageSearch(false);
    $('img-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runImageSearch(false); } });
    document.querySelectorAll('#img-sources .chip').forEach((b) => (b.onclick = () => { imgSource = b.dataset.src; document.querySelectorAll('#img-sources .chip').forEach((x) => x.classList.toggle('on', x === b)); if ($('img-q').value) runImageSearch(false); }));
    $('btn-img-open-google').onclick = () => { const q = cleanQuery($('img-q').value); if (q) window.open('https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(q), '_blank'); };
    $('btn-img-paste').onclick = pasteImage; $('btn-imgp-back').onclick = () => closeSheet('imgpreview'); $('btn-imgp-add').onclick = addSelectedImage;
    $('btn-chat-close').onclick = () => closeSheet('chat'); $('btn-chat-clear').onclick = async () => { if (!chatCard) return; chatHistory = []; await DB.del('chats', chatCard.id); renderChat(); };
    $('btn-chat-send').onclick = () => sendChat(); $('chat-text').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; });
    document.querySelectorAll('#chat-chips .chip').forEach((b) => (b.onclick = () => sendChat(b.dataset.p)));
    const goImport = () => { show('import'); renderImport(); updateWords(); };
    $('btn-import-home').onclick = goImport; $('btn-import-settings').onclick = () => { saveSettingsFromUI(); goImport(); };
    $('btn-import-back').onclick = () => { if (importJob) { importJob.cancel = true; toast('Import will stop after this section.'); } show('home'); renderHome(); };
    $('i-file').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; $('i-status').textContent = 'Reading PDF…'; try { pdfPages = await readPdf(f, (i, n) => { $('i-status').textContent = `Reading page ${i} of ${n}`; }); $('i-status').textContent = `${pdfPages.length} pages read. Choose a page range, then edit the text if you like.`; $('i-pages').classList.remove('hidden'); $('i-from').value = 1; $('i-to').value = pdfPages.length; $('i-from').max = $('i-to').max = pdfPages.length; applyRange(); } catch (err) { $('i-status').textContent = 'Could not read this PDF: ' + err.message; } };
    $('btn-i-range').onclick = applyRange; $('i-text').addEventListener('input', updateWords);
    $('btn-import-start').onclick = startImport; $('btn-import-cancel').onclick = () => { if (importJob) { importJob.cancel = true; toast('Stopping after this section…'); } };
    $('btn-q-back').onclick = () => { closeSheet('qcard'); renderImport(); };
    $('btn-q-accept').onclick = async () => { if (!qCur) return; const id = qCur.id, nxt = nextQueueId(id); await acceptQueueCard(id, { d: $('q-domain').value, q: $('q-q').value.trim(), a: $('q-a').value.trim() }); toast('Accepted'); if (nxt && nxt !== id) openQueueCard(nxt); else { closeSheet('qcard'); renderImport(); } };
    $('btn-q-discard').onclick = async () => { if (!qCur) return; const id = qCur.id, nxt = nextQueueId(id); await discardQueueCard(id); if (nxt && nxt !== id) openQueueCard(nxt); else { closeSheet('qcard'); renderImport(); } };
    $('btn-q-next').onclick = () => { const nxt = nextQueueId(qCur?.id); if (nxt) openQueueCard(nxt); };
    $('btn-q-accept-all').onclick = async () => { const ids = Object.keys(queue).filter((id) => !queue[id].dup); const dups = Object.keys(queue).length - ids.length; if (!ids.length || !confirm(`Accept ${ids.length} cards without reviewing them?${dups ? ` (${dups} possible duplicates stay in the queue)` : ''}`)) return; for (const id of ids) await acceptQueueCard(id); toast(`${ids.length} cards added`); renderImport(); };
    $('btn-q-discard-all').onclick = async () => { const ids = Object.keys(queue); if (!ids.length || !confirm(`Discard all ${ids.length} generated cards?`)) return; for (const id of ids) await discardQueueCard(id); renderImport(); };
    ['s-new', 's-max', 's-key', 's-model', 's-gkey', 's-gcx', 's-daystart', 's-retention', 's-exam', 's-bury', 's-reverse', 's-leech', 's-leechaction'].forEach((id) => ($(id).onchange = saveSettingsFromUI));
    $('btn-deck-export').onclick = exportDeck; $('btn-deck-import').onclick = () => $('deck-file').click(); $('deck-file').onchange = (e) => e.target.files[0] && importDeck(e.target.files[0]);
    $('btn-export').onclick = exportBackup; $('btn-import').onclick = () => $('import-file').click(); $('import-file').onchange = (e) => e.target.files[0] && importBackup(e.target.files[0]);
    $('btn-reset-progress').onclick = async () => { if (!confirm('Reset ALL study progress and the review log? Edits and your own cards are kept.')) return; progress = {}; stats = {}; await DB.clear('progress'); await DB.clear('stats'); await DB.clear('log'); renderSettings(); toast('Progress reset'); };
    document.addEventListener('keydown', (e) => { if (!$('study').classList.contains('active') || document.querySelector('.sheet.active')) return; if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); reveal(); } if (['1', '2', '3', '4'].includes(e.key)) rate(+e.key); });
  }

  // ---------- boot ----------
  window.addEventListener('load', async () => {
    try { await load(); } catch (e) { toast('Storage unavailable: ' + e.message, 5000); }
    wire(); renderHome();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then((reg) => { reg.addEventListener('updatefound', () => { const w = reg.installing; w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Update ready — close and reopen the app.', 5000); }); }); }).catch(() => {});
  });
  const refreshHome = () => { if (!document.hidden && $('home').classList.contains('active')) renderHome(); };
  document.addEventListener('visibilitychange', refreshHome); window.addEventListener('focus', refreshHome); window.addEventListener('pageshow', refreshHome); setInterval(refreshHome, 60000);
  window.__od = { schedule, prog, settings: () => settings, allCards: () => allCards() };
})();
