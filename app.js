/* OrthoDeck — app.js
   Spaced repetition (SM-2 variant with Anki-style learning steps), sessions,
   per-card user edits + images, and a per-card AI chat.  All state in IndexedDB. */

(() => {
  'use strict';

  // ---------- constants ----------
  const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
  const LEARN_STEPS = [1, 10];      // minutes for new cards: Good twice to graduate
  const RELEARN_STEPS = [10];       // minutes after a lapse
  const GRADUATE_IVL = 1, EASY_IVL = 4, MIN_EASE = 1.3;
  const LEARN_AHEAD = 20 * MIN;     // show learning cards up to 20 min early when nothing else is due
  const DEFAULTS = {
    id: 'main', newPerDay: 20, maxReviews: 100, domains: DOMAINS.map((d) => d.key),
    apiKey: '', model: 'claude-sonnet-4-6'
  };
  const TYPES = { classification: 'Classification', anatomy: 'Anatomy / approach', diagnosis: 'Diagnosis', management: 'Management' };
  const DOMAIN_BY_KEY = Object.fromEntries(DOMAINS.map((d) => [d.key, d]));

  // ---------- state ----------
  let settings = { ...DEFAULTS };
  let progress = {};      // id -> progress record
  let overrides = {};     // id -> {id,q,a,images}
  let userCards = {};     // id -> card
  let stats = {};         // 'YYYY-MM-DD' -> {reviews,new}
  let queue = {};         // id -> generated card awaiting review
  let importJob = null;   // running import {cancel:boolean}
  let session = null;     // {queue, done, total, undo:[], domain}
  let current = null;     // card being shown
  let revealed = false;
  let chatCard = null;
  let editCard = null;    // {card, isNew}
  let editImages = [];
  let previewCard = null;

  const $ = (id) => document.getElementById(id);
  const todayKey = () => new Date().toISOString().slice(0, 10);

  // ---------- cards ----------
  function allCards() {
    const seed = SEED_CARDS.map((c) => resolve(c));
    const mine = Object.values(userCards).map((c) => ({ ...c, user: true }));
    return seed.concat(mine);
  }
  function resolve(c) {
    const o = overrides[c.id];
    if (!o) return { ...c, images: [] };
    return { ...c, q: o.q ?? c.q, a: o.a ?? c.a, images: o.images || [], edited: true };
  }
  function cardById(id) {
    if (userCards[id]) return { ...userCards[id], user: true };
    const s = SEED_CARDS.find((c) => c.id === id);
    return s ? resolve(s) : null;
  }
  function prog(id) {
    return progress[id] || { id, state: 'new', ease: 2.5, ivl: 0, reps: 0, lapses: 0, step: 0, due: 0 };
  }

  // ---------- scheduler (SM-2 variant) ----------
  function schedule(p0, rating, now) {
    const p = { ...p0 };
    p.reps += 1;
    const fuzz = (days) => days * DAY * (1 + (Math.random() - 0.5) * 0.1);
    if (p.state === 'new' || p.state === 'learn') {
      p.state = 'learn';
      if (rating === 1) { p.step = 0; p.due = now + LEARN_STEPS[0] * MIN; }
      else if (rating === 2) {
        const cur = LEARN_STEPS[p.step], nxt = LEARN_STEPS[p.step + 1];
        p.due = now + (nxt ? (cur + nxt) / 2 : cur * 1.5) * MIN;
      } else if (rating === 3) {
        p.step += 1;
        if (p.step >= LEARN_STEPS.length) { p.state = 'review'; p.ivl = GRADUATE_IVL; p.step = 0; p.due = now + fuzz(p.ivl); }
        else p.due = now + LEARN_STEPS[p.step] * MIN;
      } else { p.state = 'review'; p.ivl = EASY_IVL; p.step = 0; p.due = now + fuzz(p.ivl); }
    } else if (p.state === 'review') {
      if (rating === 1) {
        p.lapses += 1; p.ease = Math.max(MIN_EASE, p.ease - 0.2);
        p.lapseIvl = Math.max(1, Math.round(p.ivl * 0.25));
        p.state = 'relearn'; p.step = 0; p.due = now + RELEARN_STEPS[0] * MIN;
      } else {
        if (rating === 2) { p.ivl = Math.max(p.ivl + 1, Math.round(p.ivl * 1.2)); p.ease = Math.max(MIN_EASE, p.ease - 0.15); }
        else if (rating === 3) { p.ivl = Math.max(p.ivl + 1, Math.round(p.ivl * p.ease)); }
        else { p.ivl = Math.max(p.ivl + 1, Math.round(p.ivl * p.ease * 1.3)); p.ease += 0.15; }
        p.ivl = Math.min(p.ivl, 365);
        p.due = now + fuzz(p.ivl);
      }
    } else { // relearn
      if (rating === 1) { p.step = 0; p.due = now + RELEARN_STEPS[0] * MIN; }
      else if (rating === 2) { p.due = now + RELEARN_STEPS[0] * 1.5 * MIN; }
      else {
        p.state = 'review'; p.ivl = Math.max(1, p.lapseIvl || 1); if (rating === 4) p.ivl += 1;
        p.step = 0; p.due = now + fuzz(p.ivl);
      }
    }
    return p;
  }
  function fmtIvl(ms) {
    const m = Math.round(ms / MIN);
    if (m < 60) return '<' + Math.max(1, m) + 'm';
    if (m < 24 * 60) return Math.round(m / 60) + 'h';
    const d = Math.round(m / 60 / 24);
    if (d < 30) return d + 'd';
    if (d < 365) return (d / 30).toFixed(1).replace('.0', '') + 'mo';
    return (d / 365).toFixed(1).replace('.0', '') + 'y';
  }

  // ---------- session building ----------
  function enabledCards(domainKey) {
    const keys = domainKey ? [domainKey] : settings.domains;
    return allCards().filter((c) => keys.includes(c.d));
  }
  function newToday() { return (stats[todayKey()] || {}).new || 0; }
  function counts(domainKey) {
    const now = Date.now();
    let due = 0, learn = 0, fresh = 0, seen = 0, total = 0;
    enabledCards(domainKey).forEach((c) => {
      const p = prog(c.id); total++;
      if (p.state === 'new') fresh++;
      else { seen++; if (p.due <= now) { if (p.state === 'review') due++; else learn++; } }
    });
    const newAllowed = Math.max(0, settings.newPerDay - newToday());
    return { due, learn, fresh: Math.min(fresh, newAllowed), freshTotal: fresh, seen, total };
  }
  function buildQueue(domainKey, opts = {}) {
    const now = Date.now();
    const cards = enabledCards(domainKey);
    const learning = [], review = [], fresh = [];
    cards.forEach((c) => {
      const p = prog(c.id);
      if (p.state === 'new') fresh.push(c);
      else if (p.state === 'review') { if (p.due <= now) review.push(c); }
      else if (p.due <= now + (opts.ahead ? LEARN_AHEAD : 0)) learning.push(c);
    });
    shuffle(review); shuffle(fresh);
    learning.sort((a, b) => prog(a.id).due - prog(b.id).due);
    let newAllowed = opts.limit ? opts.limit : Math.max(0, settings.newPerDay - newToday());
    if (opts.ahead) newAllowed = opts.limit || 10;
    // Weight new cards toward the OITE blueprint: pick proportionally by domain weight.
    const picked = weightedPick(fresh, newAllowed);
    let q = learning.concat(review.slice(0, settings.maxReviews));
    // interleave new cards among reviews so a session isn't review-only then new-only
    picked.forEach((c, i) => { const pos = Math.min(q.length, Math.floor((i + 1) * q.length / (picked.length + 1)) + i); q.splice(pos, 0, c); });
    if (opts.limit && !opts.ahead) q = q.slice(0, opts.limit);
    return q;
  }
  function weightedPick(cards, n) {
    if (cards.length <= n) return cards.slice();
    const byDom = {}; cards.forEach((c) => (byDom[c.d] = byDom[c.d] || []).push(c));
    const out = [];
    const weights = Object.keys(byDom).map((k) => ({ k, w: DOMAIN_BY_KEY[k] ? DOMAIN_BY_KEY[k].weight : 5 }));
    let guard = 0;
    while (out.length < n && guard++ < 5000) {
      const totalW = weights.reduce((s, x) => s + (byDom[x.k].length ? x.w : 0), 0);
      if (!totalW) break;
      let r = Math.random() * totalW;
      for (const x of weights) { if (!byDom[x.k].length) continue; r -= x.w; if (r <= 0) { out.push(byDom[x.k].pop()); break; } }
    }
    return out;
  }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  // ---------- persistence ----------
  async function load() {
    const s = await DB.get('settings', 'main');
    settings = { ...DEFAULTS, ...(s || {}) };
    (await DB.getAll('progress')).forEach((p) => (progress[p.id] = p));
    (await DB.getAll('overrides')).forEach((o) => (overrides[o.id] = o));
    (await DB.getAll('usercards')).forEach((c) => (userCards[c.id] = c));
    (await DB.getAll('stats')).forEach((s) => (stats[s.id] = s));
    (await DB.getAll('queue')).forEach((q) => (queue[q.id] = q));
  }
  const saveSettings = () => DB.put('settings', settings);
  async function bumpStats(isNew) {
    const k = todayKey();
    stats[k] = stats[k] || { id: k, reviews: 0, new: 0 };
    stats[k].reviews++; if (isNew) stats[k].new++;
    await DB.put('stats', stats[k]);
  }

  // ---------- navigation ----------
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    window.scrollTo(0, 0);
  }
  function openSheet(id) { $(id).classList.add('active'); }
  function closeSheet(id) { $(id).classList.remove('active'); }
  let toastT;
  function toast(msg, ms = 2200) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }

  // ---------- home ----------
  function renderHome() {
    const c = counts();
    const parts = [];
    if (c.due) parts.push(`<em>${c.due}</em> ${c.due === 1 ? 'card' : 'cards'} due`);
    if (c.learn) parts.push(`<em>${c.learn}</em> still learning`);
    if (c.fresh) parts.push(`<em>${c.fresh}</em> new`);
    $('due-lead').innerHTML = parts.length ? parts.join(', ') + '.' : (c.freshTotal ? 'All caught up. New cards unlock tomorrow.' : 'All caught up.');
    const qn = Object.keys(queue).length; $('queue-note').classList.toggle('hidden', !qn);
    $('queue-note').innerHTML = qn ? `<b style="color:var(--accent)">${qn}</b> generated ${qn === 1 ? 'card is' : 'cards are'} waiting for your review.` : '';
    $('btn-start').disabled = !(c.due + c.learn + c.fresh);
    $('btn-start').textContent = (c.due + c.learn + c.fresh) ? `Start studying (${c.due + c.learn + c.fresh})` : 'Nothing due';
    const list = $('domain-list'); list.innerHTML = '';
    DOMAINS.forEach((d) => {
      const dc = counts(d.key); const on = settings.domains.includes(d.key);
      const b = document.createElement('button'); b.className = 'domain' + (on ? '' : ' off');
      const pct = dc.total ? Math.round(100 * dc.seen / dc.total) : 0;
      b.innerHTML = `<span class="name">${d.name}</span><span class="due">${dc.due + dc.learn ? (dc.due + dc.learn) + ' due' : ''}</span>
        <span class="meta">${d.weight}% of OITE · ${dc.seen}/${dc.total} seen${on ? '' : ' · paused'}</span><span class="meta"></span>
        <span class="prog"><i style="width:${pct}%"></i></span>`;
      b.onclick = () => startSession(d.key);
      list.appendChild(b);
    });
  }

  // ---------- study ----------
  function startSession(domainKey, opts) {
    const queue = buildQueue(domainKey, opts);
    if (!queue.length) { toast(domainKey ? 'Nothing due in this domain — try Study ahead from the deck.' : 'Nothing due right now.'); return; }
    session = { queue, done: 0, total: queue.length, undo: [], domain: domainKey || null, again: 0 };
    $('study-title').textContent = domainKey ? DOMAIN_BY_KEY[domainKey].name : (opts && opts.limit ? 'Quick session' : 'Studying');
    $('done').classList.add('hidden'); $('cardwrap').classList.remove('hidden');
    document.querySelector('#study .toolrow').classList.remove('hidden');
    show('study'); nextCard();
  }
  function nextCard() {
    const now = Date.now();
    if (!session.queue.length) return finishSession();
    // learning cards not yet due sit at the front only if nothing else is available
    let idx = session.queue.findIndex((c) => { const p = prog(c.id); return p.state === 'new' || p.state === 'review' || p.due <= now; });
    if (idx < 0) idx = 0;
    current = cardById(session.queue[idx].id) || session.queue[idx];
    session.queue.splice(idx, 1);
    revealed = false; renderCard();
    $('study-progress').style.width = Math.round(100 * session.done / session.total) + '%';
  }
  function renderCard() {
    const c = current, p = prog(c.id);
    $('c-domain').innerHTML = `<b>${DOMAIN_BY_KEY[c.d]?.name || 'Custom'}</b>${c.user ? ' · yours' : ''}`;
    $('c-type').textContent = (TYPES[c.t] || '') + (p.state === 'new' ? ' · new' : p.state === 'review' ? '' : ' · learning');
    $('c-q').textContent = c.q;
    $('c-a').textContent = c.a;
    const imgs = $('c-imgs'); imgs.innerHTML = '';
    (c.images || []).forEach((src) => { const im = document.createElement('img'); im.src = src; im.alt = 'Your image'; imgs.appendChild(im); });
    $('c-edited').textContent = c.edited ? 'Edited by you' : '';
    $('c-reveal').classList.toggle('hidden', !revealed);
    $('c-hint').classList.toggle('hidden', revealed);
    $('showbar').classList.toggle('hidden', revealed);
    $('ratebar').classList.toggle('hidden', !revealed);
    if (revealed) {
      const now = Date.now();
      [1, 2, 3, 4].forEach((r) => { const np = schedule(p, r, now); $('iv' + r).textContent = fmtIvl(np.due - now); });
    }
    $('btn-undo').style.visibility = session && session.undo.length ? 'visible' : 'hidden';
    $('card').scrollTop = 0;
  }
  function reveal() { if (revealed) return; revealed = true; renderCard(); }
  async function rate(r) {
    if (!current || !revealed) return;
    const now = Date.now(), before = prog(current.id), isNew = before.state === 'new';
    const after = schedule(before, r, now);
    session.undo.push({ card: current, before: progress[current.id] ? { ...progress[current.id] } : null, queue: session.queue.slice(), done: session.done, isNew });
    if (session.undo.length > 20) session.undo.shift();
    progress[current.id] = after; await DB.put('progress', after); await bumpStats(isNew);
    if (after.state === 'learn' || after.state === 'relearn') {
      // re-queue a few cards later
      const pos = Math.min(session.queue.length, 3);
      session.queue.splice(pos, 0, current); if (r === 1) session.again++; session.total++;
    }
    session.done++;
    animate(r === 1 ? 'swipe-left' : 'swipe-right'); nextCard();
  }
  function animate(cls) { const el = $('card'); el.classList.add(cls); setTimeout(() => el.classList.remove(cls), 180); }
  async function undo() {
    if (!session || !session.undo.length) return;
    const u = session.undo.pop();
    if (u.before) { progress[u.card.id] = u.before; await DB.put('progress', u.before); }
    else { delete progress[u.card.id]; await DB.del('progress', u.card.id); }
    const k = todayKey(); if (stats[k]) { stats[k].reviews = Math.max(0, stats[k].reviews - 1); if (u.isNew) stats[k].new = Math.max(0, stats[k].new - 1); await DB.put('stats', stats[k]); }
    session.queue = u.queue; session.done = u.done; session.total = Math.max(session.total, u.queue.length + u.done + 1);
    if (current) session.queue.unshift(current);
    current = cardById(u.card.id) || u.card; revealed = false; renderCard();
    toast('Rating undone');
  }
  function skip() { if (!current) return; session.queue.push(current); nextCard(); }
  function finishSession() {
    $('cardwrap').classList.add('hidden'); $('ratebar').classList.add('hidden'); $('showbar').classList.add('hidden');
    document.querySelector('#study .toolrow').classList.add('hidden');
    $('done').classList.remove('hidden');
    $('done-summary').textContent = `${session.done} reviews · ${session.again} marked Again`;
    $('study-progress').style.width = '100%';
    current = null;
  }

  // swipe: right = Good, left = Again (after reveal); before reveal, any swipe reveals.
  (function swipe() {
    const el = $('card'); let x0 = null, y0 = null, moved = false;
    el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; moved = false; }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (x0 === null) return; const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) { moved = true; el.style.transform = `translateX(${dx * 0.35}px) rotate(${dx * 0.02}deg)`; }
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      const dx = (e.changedTouches[0].clientX - x0) || 0; el.style.transform = ''; x0 = null;
      if (moved && Math.abs(dx) > 70) { if (!revealed) reveal(); else rate(dx > 0 ? 3 : 1); }
      else if (!moved) reveal();
    });
  })();

  // ---------- browse ----------
  let browseDomain = null;
  function renderBrowse() {
    const chips = $('browse-chips'); chips.innerHTML = '';
    [{ key: null, name: 'All' }].concat(DOMAINS).concat([{ key: '__mine', name: 'Mine' }, { key: '__edited', name: 'Edited' }]).forEach((d) => {
      const b = document.createElement('button'); b.className = 'chip' + (browseDomain === d.key ? ' on' : ''); b.textContent = d.name;
      b.onclick = () => { browseDomain = d.key; renderBrowse(); }; chips.appendChild(b);
    });
    const term = $('search').value.trim().toLowerCase();
    let cards = allCards();
    if (browseDomain === '__mine') cards = cards.filter((c) => c.user);
    else if (browseDomain === '__edited') cards = cards.filter((c) => c.edited);
    else if (browseDomain) cards = cards.filter((c) => c.d === browseDomain);
    if (term) cards = cards.filter((c) => (c.q + ' ' + c.a).toLowerCase().includes(term));
    const list = $('browse-list'); list.innerHTML = '';
    const now = Date.now();
    cards.slice(0, 300).forEach((c) => {
      const p = prog(c.id);
      const b = document.createElement('button'); b.className = 'item';
      const sched = p.state === 'new' ? 'new' : (p.due <= now ? 'due now' : 'due in ' + fmtIvl(p.due - now));
      b.innerHTML = `<div class="iq">${esc(c.q)}</div><div class="im"><b>${DOMAIN_BY_KEY[c.d]?.name || 'Custom'}</b> · ${TYPES[c.t] || ''} · ${sched}${c.user ? ' · yours' : c.edited ? ' · edited' : ''}</div>`;
      b.onclick = () => openPreview(c.id); list.appendChild(b);
    });
    if (!cards.length) list.innerHTML = '<p class="note">No cards match. Try fewer words, or add one with +.</p>';
    else if (cards.length > 300) list.insertAdjacentHTML('beforeend', `<p class="note">Showing 300 of ${cards.length}. Narrow the search to see the rest.</p>`);
  }
  const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

  function openPreview(id) {
    previewCard = cardById(id); if (!previewCard) return;
    const c = previewCard, p = prog(id), now = Date.now();
    $('p-meta').innerHTML = `<b style="color:var(--accent)">${DOMAIN_BY_KEY[c.d]?.name || 'Custom'}</b> · ${TYPES[c.t] || ''}${c.user ? ' · yours' : c.edited ? ' · edited by you' : ''}`;
    $('p-q').textContent = c.q; $('p-a').textContent = c.a;
    const imgs = $('p-imgs'); imgs.innerHTML = ''; (c.images || []).forEach((src) => { const im = document.createElement('img'); im.src = src; im.style.maxWidth = '100%'; im.style.borderRadius = '10px'; imgs.appendChild(im); });
    $('p-sched').textContent = p.state === 'new' ? 'Not studied yet.' : `${p.reps} reviews · ${p.lapses} lapses · interval ${p.ivl}d · ease ${p.ease.toFixed(2)} · ${p.due <= now ? 'due now' : 'due in ' + fmtIvl(p.due - now)}`;
    openSheet('preview');
  }

  // ---------- edit ----------
  function openEdit(card, isNew) {
    editCard = { card, isNew }; editImages = (card.images || []).slice();
    $('edit-title').textContent = isNew ? 'New card' : 'Edit card';
    const sel = $('e-domain'); sel.innerHTML = DOMAINS.map((d) => `<option value="${d.key}">${d.name}</option>`).join('');
    sel.value = card.d || 'trauma';
    $('edit-domain-field').classList.toggle('hidden', !(isNew || card.user));
    $('e-q').value = card.q || ''; $('e-a').value = card.a || ''; $('e-img').value = '';
    $('btn-edit-revert').classList.toggle('hidden', !(card.edited && !card.user));
    $('btn-edit-delete').classList.toggle('hidden', !card.user);
    renderThumbs(); openSheet('edit');
  }
  function renderThumbs() {
    const t = $('e-thumbs'); t.innerHTML = '';
    editImages.forEach((src, i) => {
      const w = document.createElement('div'); w.className = 't';
      w.innerHTML = `<img src="${src}" alt=""><button class="x" aria-label="Remove image">×</button>`;
      w.querySelector('.x').onclick = () => { editImages.splice(i, 1); renderThumbs(); }; t.appendChild(w);
    });
  }
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 1200; let { width: w, height: h } = img; const s = Math.min(1, max / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s);
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url); resolve(cv.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
      img.src = url;
    });
  }
  async function saveEdit() {
    const q = $('e-q').value.trim(), a = $('e-a').value.trim();
    if (!q || !a) { toast('Both front and back are needed.'); return; }
    const { card, isNew } = editCard;
    if (isNew || card.user) {
      const id = isNew ? 'u_' + Date.now().toString(36) : card.id;
      const rec = { id, d: $('e-domain').value, t: card.t || 'management', q, a, images: editImages, created: card.created || Date.now() };
      userCards[id] = rec; await DB.put('usercards', rec);
    } else {
      const base = SEED_CARDS.find((c) => c.id === card.id);
      const rec = { id: card.id, q: q === base.q ? undefined : q, a: a === base.a ? undefined : a, images: editImages };
      if (rec.q === undefined && rec.a === undefined && !editImages.length) { delete overrides[card.id]; await DB.del('overrides', card.id); }
      else { overrides[card.id] = rec; await DB.put('overrides', rec); }
    }
    closeSheet('edit'); afterEdit(isNew ? null : card.id); toast(isNew ? 'Card added' : 'Saved');
  }
  async function revertEdit() {
    const id = editCard.card.id; delete overrides[id]; await DB.del('overrides', id);
    closeSheet('edit'); afterEdit(id); toast('Reverted to built-in card');
  }
  async function deleteUserCard() {
    const id = editCard.card.id; delete userCards[id]; await DB.del('usercards', id); delete progress[id]; await DB.del('progress', id);
    closeSheet('edit'); closeSheet('preview'); if (current && current.id === id) nextCard(); renderBrowse(); renderHome(); toast('Card deleted');
  }
  function afterEdit(id) {
    if (current && current.id === id) { current = cardById(id); renderCard(); }
    if (previewCard && previewCard.id === id) openPreview(id);
    if ($('browse').classList.contains('active')) renderBrowse();
    renderHome();
  }

  // ---------- chat ----------
  let chatHistory = [];
  async function openChat(card) {
    chatCard = card;
    const saved = await DB.get('chats', card.id); chatHistory = saved ? saved.messages : [];
    renderChat(); openSheet('chat');
    if (!settings.apiKey) toast('Add your Anthropic API key in Settings to use chat.', 3500);
  }
  function renderChat() {
    const l = $('chat-list'); l.innerHTML = '';
    const sys = document.createElement('div'); sys.className = 'msg sys';
    sys.textContent = 'Answers are grounded in this card and may be wrong. Verify management details against primary sources.';
    l.appendChild(sys);
    chatHistory.forEach((m) => { const d = document.createElement('div'); d.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai'); d.textContent = m.content; l.appendChild(d); });
    l.scrollTop = l.scrollHeight;
  }
  function systemPrompt(card) {
    return `You are a study tutor inside OrthoDeck, an orthopaedic surgery board-prep flashcard app (OITE / ABOS Part I level). The user is looking at one flashcard and reads your answers on a phone screen, so be concise: short paragraphs, plain text, no markdown headers, no bullet lists unless a list is clearly the best format.

Ground everything in the card below. Explain mechanism, compare against the plausible wrong answers ('why not X'), connect related classification systems, and offer memory hooks when asked. If the card's content looks outdated, controversial, or you are unsure, say so plainly rather than guessing. This is a study aid, not a clinical reference: when you give management or dosing details, end with a one-line reminder to verify against primary sources. Do not invent citations.

Domain: ${DOMAIN_BY_KEY[card.d]?.name || 'Custom'}
Card type: ${TYPES[card.t] || 'general'}
Front: ${card.q}
Back: ${card.a}`;
  }
  async function sendChat(text) {
    text = (text || $('chat-text').value).trim(); if (!text || !chatCard) return;
    if (!settings.apiKey) { toast('Add your Anthropic API key in Settings first.'); return; }
    $('chat-text').value = ''; $('chat-text').style.height = 'auto';
    chatHistory.push({ role: 'user', content: text }); renderChat();
    const thinking = document.createElement('div'); thinking.className = 'msg ai'; thinking.textContent = '…'; $('chat-list').appendChild(thinking);
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: settings.model || DEFAULTS.model, max_tokens: 800, system: systemPrompt(chatCard), messages: chatHistory.slice(-12) })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error?.message || ('HTTP ' + resp.status));
      const reply = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || '(no reply)';
      chatHistory.push({ role: 'assistant', content: reply });
      await DB.put('chats', { id: chatCard.id, messages: chatHistory });
    } catch (e) {
      chatHistory.pop(); // drop the unsent user turn so history stays valid
      const msg = /Failed to fetch/i.test(e.message) ? 'No connection, or the request was blocked. Chat needs a signal; studying does not.' : 'Chat failed: ' + e.message;
      renderChat(); $('chat-text').value = text; toast(msg, 4500); return;
    }
    renderChat();
  }


  // ---------- import: PDF/text -> Claude -> review queue ----------
  const IMPORT_SYSTEM = (domainKey, density) => `You write orthopaedic board-review flashcards (OITE / ABOS Part I level) from source text supplied by the user. Return ONLY a JSON array, no prose, no markdown fences.

Each element: {"d": domain key, "t": card type, "q": front, "a": back}.
Domain keys: ${DOMAINS.map((x) => x.key + ' = ' + x.name).join(', ')}.${domainKey === 'auto' ? ' Choose the best domain per card.' : ' Use "' + domainKey + '" for every card.'}
Card types: classification, anatomy, diagnosis, management.

Rules:
- Write in your own words. Do not copy sentences or tables from the source; reorganize facts into recall-friendly Q/A. Facts, numbers, eponyms and classifications are fine.
- One card per testable concept: a classification system, a nerve/vessel at risk, a threshold number, a management decision, a distinguishing feature. ${density === 'dense' ? 'Prefer many short cards (one fact each).' : density === 'light' ? 'Only the highest-yield concepts; skip minor detail.' : 'Group closely related facts into one card so the back reads as a compact summary.'}
- Fronts are specific questions or prompts ("Garden classification stages", "Which root does an L4-5 far-lateral disc hit?"), not chapter headings.
- Backs are concise, use line breaks (\\n) between items, and stay under ~120 words.
- Skip prose about history, author acknowledgements, references, figure captions, and page furniture.
- If the text contains no board-relevant content, return [].`;

  function chunkText(text, words = 4500) {
    const w = text.split(/\s+/).filter(Boolean); const out = [];
    for (let i = 0; i < w.length; i += words) out.push(w.slice(i, i + words).join(' '));
    return out;
  }
  async function pdfToText(file, onPage) {
    const pdfjs = await import('./vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i); const c = await page.getTextContent();
      text += c.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('') + '\n';
      onPage && onPage(i, doc.numPages);
    }
    return text;
  }
  function parseCards(raw) {
    let t = raw.replace(/```json|```/g, '').trim();
    const a = t.indexOf('['), b = t.lastIndexOf(']'); if (a < 0 || b < 0) return [];
    try { const arr = JSON.parse(t.slice(a, b + 1)); return Array.isArray(arr) ? arr : []; } catch (e) { return []; }
  }
  async function generateCards(chunk, domainKey, density) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: settings.model || DEFAULTS.model, max_tokens: 8000, system: IMPORT_SYSTEM(domainKey, density), messages: [{ role: 'user', content: 'SOURCE TEXT:\n\n' + chunk }] })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || ('HTTP ' + resp.status));
    return parseCards((data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
  }
  async function startImport() {
    if (!settings.apiKey) { toast('Add your Anthropic API key in Settings first.', 3500); return; }
    const file = $('i-file').files[0]; const pasted = $('i-text').value.trim();
    if (!file && !pasted) { toast('Choose a PDF or paste some text.'); return; }
    const domainKey = $('i-domain').value, density = $('i-density').value;
    const source = file ? file.name : 'Pasted text ' + todayKey();
    $('import-setup').classList.add('hidden'); $('import-progress').classList.remove('hidden'); $('import-review').classList.add('hidden');
    importJob = { cancel: false };
    const lead = $('i-progress-lead'), bar = $('i-progress-bar'), note = $('i-progress-note');
    let text = pasted;
    try {
      if (file) { lead.textContent = 'Reading the PDF…'; text = await pdfToText(file, (i, n) => { bar.style.width = Math.round(20 * i / n) + '%'; note.textContent = `Page ${i} of ${n}`; }); }
      const chunks = chunkText(text);
      if (!chunks.length) throw new Error('No readable text found. Scanned PDFs without a text layer are not supported.');
      let made = 0;
      for (let i = 0; i < chunks.length; i++) {
        if (importJob.cancel) break;
        lead.textContent = `Writing cards… ${made} so far`; note.textContent = `Section ${i + 1} of ${chunks.length}`; bar.style.width = Math.round(20 + 80 * i / chunks.length) + '%';
        let cards = [];
        try { cards = await generateCards(chunks[i], domainKey, density); }
        catch (e) { toast('Section ' + (i + 1) + ' failed: ' + e.message, 4000); continue; }
        for (const c of cards) {
          if (!c || !c.q || !c.a) continue;
          const rec = { id: 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6), d: DOMAIN_BY_KEY[c.d] ? c.d : (domainKey !== 'auto' ? domainKey : 'trauma'), t: TYPES[c.t] ? c.t : 'management', q: String(c.q).trim(), a: String(c.a).trim(), src: source, created: Date.now() };
          queue[rec.id] = rec; await DB.put('queue', rec); made++;
        }
      }
      bar.style.width = '100%';
      toast(made ? `${made} cards ready for review` : 'No cards were generated.', 3500);
    } catch (e) { toast('Import failed: ' + e.message, 5000); }
    importJob = null; $('i-file').value = ''; $('i-text').value = '';
    renderImport();
  }
  function renderImport() {
    const ids = Object.keys(queue);
    $('import-progress').classList.add('hidden');
    $('import-setup').classList.toggle('hidden', !!ids.length);
    $('import-review').classList.toggle('hidden', !ids.length);
    if (!$('i-domain').options.length || $('i-domain').options.length === 1) {
      DOMAINS.forEach((d) => { const o = document.createElement('option'); o.value = d.key; o.textContent = d.name; $('i-domain').appendChild(o); });
    }
    if (!ids.length) return;
    $('i-review-lead').innerHTML = `<em>${ids.length}</em> ${ids.length === 1 ? 'card' : 'cards'} to review. Tap one to edit, accept, or discard.`;
    const list = $('i-queue'); list.innerHTML = '';
    ids.map((id) => queue[id]).sort((a, b) => a.created - b.created).forEach((c) => {
      const b = document.createElement('button'); b.className = 'item';
      b.innerHTML = `<div class="iq">${esc(c.q)}</div><div class="im"><b>${DOMAIN_BY_KEY[c.d]?.name}</b> · ${TYPES[c.t]} · from ${esc(c.src)}</div>`;
      b.onclick = () => openQueueCard(c.id); list.appendChild(b);
    });
  }
  let qCur = null;
  function openQueueCard(id) {
    qCur = queue[id]; if (!qCur) return;
    const sel = $('q-domain'); sel.innerHTML = DOMAINS.map((d) => `<option value="${d.key}">${d.name}</option>`).join(''); sel.value = qCur.d;
    $('q-q').value = qCur.q; $('q-a').value = qCur.a; $('q-src').textContent = 'Generated from ' + qCur.src + '. Check it against the source before accepting — the model can misread tables and numbers.';
    openSheet('qcard');
  }
  async function acceptQueueCard(id, edits) {
    const c = queue[id]; if (!c) return;
    const rec = { id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), d: edits?.d || c.d, t: c.t, q: edits?.q || c.q, a: edits?.a || c.a, images: [], src: c.src, created: Date.now() };
    userCards[rec.id] = rec; await DB.put('usercards', rec);
    delete queue[id]; await DB.del('queue', id);
  }
  async function discardQueueCard(id) { delete queue[id]; await DB.del('queue', id); }
  function nextQueueId(after) { const ids = Object.keys(queue).sort((a, b) => queue[a].created - queue[b].created); const i = ids.indexOf(after); return ids[(i + 1) % ids.length] || null; }

  // ---------- settings ----------
  function renderSettings() {
    $('s-new').value = settings.newPerDay; $('s-max').value = settings.maxReviews; $('s-key').value = settings.apiKey; $('s-model').value = settings.model;
    const d = $('s-domains'); d.innerHTML = '';
    DOMAINS.forEach((dm) => {
      const l = document.createElement('label'); l.className = 'toggle';
      l.innerHTML = `<span>${dm.name} <span style="color:var(--muted);font-size:13px">${dm.weight}%</span></span><input type="checkbox" ${settings.domains.includes(dm.key) ? 'checked' : ''}>`;
      l.querySelector('input').onchange = (e) => { settings.domains = DOMAINS.map((x) => x.key).filter((k) => k === dm.key ? e.target.checked : settings.domains.includes(k)); saveSettings(); };
      d.appendChild(l);
    });
    $('k-seed').textContent = SEED_CARDS.length; $('k-user').textContent = Object.keys(userCards).length; $('k-edited').textContent = Object.keys(overrides).length;
    $('k-reviews').textContent = Object.values(stats).reduce((s, x) => s + (x.reviews || 0), 0);
    $('about-text').textContent = `OrthoDeck ${APP_VERSION}. Seed deck weighted to the AAOS OITE content blueprint: ` + DOMAINS.map((x) => `${x.name} ${x.weight}%`).join(', ') + '. Scheduling is an SM-2 variant with 1 min / 10 min learning steps, ease 2.5 starting, lapses drop ease by 0.2. Built-in card text is a starting point written for study, not a clinical reference.';
  }
  async function exportBackup() {
    const data = { app: 'orthodeck', version: APP_VERSION, exported: new Date().toISOString(), progress: Object.values(progress), overrides: Object.values(overrides), usercards: Object.values(userCards), chats: await DB.getAll('chats'), stats: Object.values(stats), queue: Object.values(queue), settings: { ...settings, apiKey: '' } };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `orthodeck-backup-${todayKey()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function importBackup(file) {
    try {
      const data = JSON.parse(await file.text()); if (data.app !== 'orthodeck') throw new Error('Not an OrthoDeck backup');
      await DB.putMany('progress', data.progress || []); await DB.putMany('overrides', data.overrides || []); await DB.putMany('usercards', data.usercards || []); await DB.putMany('chats', data.chats || []); await DB.putMany('stats', data.stats || []); await DB.putMany('queue', data.queue || []);
      if (data.settings) { settings = { ...settings, ...data.settings, apiKey: settings.apiKey }; await saveSettings(); }
      progress = {}; overrides = {}; userCards = {}; stats = {}; queue = {}; await load(); renderSettings(); renderHome(); toast('Backup restored');
    } catch (e) { toast('Import failed: ' + e.message, 4000); }
  }

  // ---------- wiring ----------
  function wire() {
    $('btn-start').onclick = () => startSession(null);
    $('btn-quick').onclick = () => startSession(null, { limit: 10, ahead: true });
    $('btn-browse').onclick = () => { show('browse'); renderBrowse(); };
    $('btn-settings').onclick = () => { show('settings'); renderSettings(); };
    $('btn-settings-back').onclick = () => { show('home'); renderHome(); };
    $('btn-browse-back').onclick = () => { show('home'); renderHome(); };
    $('btn-study-close').onclick = () => { session = null; current = null; show('home'); renderHome(); };
    $('btn-show').onclick = reveal;
    $('btn-undo').onclick = undo;
    $('btn-skip').onclick = skip;
    document.querySelectorAll('#ratebar button').forEach((b) => (b.onclick = () => rate(+b.dataset.r)));
    $('btn-done-home').onclick = () => { session = null; show('home'); renderHome(); };
    $('btn-done-more').onclick = () => startSession(session ? session.domain : null, { limit: 10, ahead: true });
    $('btn-edit').onclick = () => current && openEdit(current, false);
    $('btn-chat').onclick = () => current && openChat(current);
    $('btn-new-card').onclick = () => openEdit({ d: browseDomain && !browseDomain.startsWith('__') ? browseDomain : 'trauma', t: 'management', q: '', a: '', images: [] }, true);
    $('search').oninput = renderBrowse;
    $('btn-preview-close').onclick = () => closeSheet('preview');
    $('btn-p-edit').onclick = () => previewCard && openEdit(previewCard, false);
    $('btn-p-chat').onclick = () => previewCard && openChat(previewCard);
    $('btn-p-study').onclick = () => { if (!previewCard) return; closeSheet('preview'); session = { queue: [previewCard], done: 0, total: 1, undo: [], domain: null, again: 0 }; $('study-title').textContent = 'Single card'; $('done').classList.add('hidden'); $('cardwrap').classList.remove('hidden'); document.querySelector('#study .toolrow').classList.remove('hidden'); show('study'); nextCard(); };
    $('btn-p-reset').onclick = async () => { if (!previewCard || !confirm('Reset progress on this card?')) return; delete progress[previewCard.id]; await DB.del('progress', previewCard.id); openPreview(previewCard.id); renderBrowse(); };
    $('btn-edit-cancel').onclick = () => closeSheet('edit');
    $('btn-edit-save').onclick = saveEdit;
    $('btn-edit-revert').onclick = () => confirm('Discard your edits and images for this card?') && revertEdit();
    $('btn-edit-delete').onclick = () => confirm('Delete this card permanently?') && deleteUserCard();
    $('e-img').onchange = async (e) => { for (const f of e.target.files) { try { editImages.push(await fileToDataURL(f)); } catch (err) { toast(err.message); } } renderThumbs(); };
    $('btn-chat-close').onclick = () => closeSheet('chat');
    $('btn-chat-clear').onclick = async () => { if (!chatCard) return; chatHistory = []; await DB.del('chats', chatCard.id); renderChat(); };
    $('btn-chat-send').onclick = () => sendChat();
    $('chat-text').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; });
    document.querySelectorAll('#chat-chips .chip').forEach((b) => (b.onclick = () => sendChat(b.dataset.p)));
    ['s-new', 's-max', 's-key', 's-model'].forEach((id) => ($(id).onchange = () => {
      settings.newPerDay = Math.max(0, +$('s-new').value || 0); settings.maxReviews = Math.max(5, +$('s-max').value || 100);
      settings.apiKey = $('s-key').value.trim(); settings.model = $('s-model').value.trim() || DEFAULTS.model; saveSettings();
    }));

    // import
    const goImport = () => { show('import'); renderImport(); };
    $('btn-import-home').onclick = goImport; $('btn-import-settings').onclick = goImport;
    $('btn-import-back').onclick = () => { if (importJob) { toast('Import is still running — it will stop after this section.'); importJob.cancel = true; } show('home'); renderHome(); };
    $('btn-import-start').onclick = startImport;
    $('btn-import-cancel').onclick = () => { if (importJob) { importJob.cancel = true; toast('Stopping after this section…'); } };
    $('btn-q-back').onclick = () => { closeSheet('qcard'); renderImport(); };
    $('btn-q-accept').onclick = async () => { if (!qCur) return; const id = qCur.id; const nxt = nextQueueId(id); await acceptQueueCard(id, { d: $('q-domain').value, q: $('q-q').value.trim(), a: $('q-a').value.trim() }); toast('Accepted'); if (nxt && nxt !== id) openQueueCard(nxt); else { closeSheet('qcard'); renderImport(); } };
    $('btn-q-discard').onclick = async () => { if (!qCur) return; const id = qCur.id; const nxt = nextQueueId(id); await discardQueueCard(id); if (nxt && nxt !== id) openQueueCard(nxt); else { closeSheet('qcard'); renderImport(); } };
    $('btn-q-next').onclick = () => { const nxt = nextQueueId(qCur?.id); if (nxt) openQueueCard(nxt); };
    $('btn-q-accept-all').onclick = async () => { const ids = Object.keys(queue); if (!ids.length || !confirm(`Accept all ${ids.length} cards without reviewing them?`)) return; for (const id of ids) await acceptQueueCard(id); toast(`${ids.length} cards added`); renderImport(); };
    $('btn-q-discard-all').onclick = async () => { const ids = Object.keys(queue); if (!ids.length || !confirm(`Discard all ${ids.length} generated cards?`)) return; for (const id of ids) await discardQueueCard(id); renderImport(); };
    $('btn-export').onclick = exportBackup;
    $('btn-import').onclick = () => $('import-file').click();
    $('import-file').onchange = (e) => e.target.files[0] && importBackup(e.target.files[0]);
    $('btn-reset-progress').onclick = async () => { if (!confirm('Reset ALL study progress? Edits and your own cards are kept.')) return; progress = {}; stats = {}; await DB.clear('progress'); await DB.clear('stats'); renderSettings(); toast('Progress reset'); };
    // keyboard (desktop testing)
    document.addEventListener('keydown', (e) => {
      if (!$('study').classList.contains('active') || document.querySelector('.sheet.active')) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); reveal(); }
      if (['1', '2', '3', '4'].includes(e.key)) rate(+e.key);
    });
  }

  // ---------- boot ----------
  const APP_VERSION = 'v1.2';
  window.addEventListener('load', async () => {
    try { await load(); } catch (e) { toast('Storage unavailable: ' + e.message, 5000); }
    wire(); renderHome();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const w = reg.installing; w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Update ready — close and reopen the app.', 5000); });
        });
      }).catch(() => {});
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && $('home').classList.contains('active')) renderHome(); });
})();
