/* Cellar Book — screens: header, Journal, Cellar, Palate, wine details, logging form, Settings, startup. */
'use strict';

/* ---------- Header ---------- */
function renderHeader() {
  const all = [...S.wines.values()];
  const tasted = all.filter(isTasted).length;
  const bottles = all.reduce((a, w) => a + (Number(w.bottles) || 0), 0);
  $('#sub').textContent = S.loaded ? `${tasted} ${tasted === 1 ? 'wine' : 'wines'} tasted · ${bottles} ${bottles === 1 ? 'bottle' : 'bottles'} in the cellar` : 'Opening your cellar book…';
  renderSyncChip();
}

/* ---------- Journal ---------- */
function setupJournalControls() {
  $('#cfilter').innerHTML = `<option value="all">All styles</option>` + COLORS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  const chips = [['all', 'All tasted'], ...RATINGS.map(r => [r.key, r.label]), ['unrated', 'Not rated'], ['want', 'Want to try']];
  $('#rfilter').innerHTML = chips.map(([k, l]) => {
    const c = k === 'all' ? '' : `<span class="dot" style="--c:var(--${k === 'want' ? 'accent' : k === 'unrated' ? 'muted' : k})"></span>`;
    return `<button class="chip" type="button" data-f="${k}" aria-pressed="${k === 'all'}">${c}${l}</button>`;
  }).join('');
  $('#rfilter').addEventListener('click', e => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    S.rfilter = b.dataset.f;
    $$('#rfilter [data-f]').forEach(x => x.setAttribute('aria-pressed', x === b));
    renderJournal();
  });
  $('#q').addEventListener('input', e => { S.q = e.target.value; renderJournal(); });
  $('#cfilter').addEventListener('change', e => { S.cfilter = e.target.value; renderJournal(); });
  $('#sort').addEventListener('change', e => { S.sort = e.target.value; renderJournal(); });
}

function wineRow(w, side) {
  const grapes = grapesOf(w).join(', ');
  const meta = [grapes, placeOf(w)].filter(Boolean).join(' · ');
  return `<button class="wine" type="button" data-open="${esc(w.id)}">
    <span class="glass" style="--g:${colorVar(w.color)}" title="${esc(CMAP[w.color] || '')}"></span>
    <span class="w-main">
      ${w.producer ? `<span class="w-prod">${esc(w.producer)}</span>` : ''}
      <span class="w-name">${esc(w.name || w.producer || 'Unnamed wine')}<span class="w-vint">${esc(w.vintage || 'NV')}</span></span>
      ${meta ? `<span class="w-meta">${esc(meta)}</span>` : (w.needs_details ? '<span class="w-meta">Claude is filling in details…</span>' : '')}
    </span>
    <span class="w-side">${side}</span>
  </button>`;
}
function emptyState(title, body) { return `<div class="empty"><h3>${esc(title)}</h3><p>${body}</p></div>`; }

function welcomeCard() {
  const steps = [];
  if (!hasClaude()) steps.push('Add your <b>Claude API key</b> so Cellar Book can read labels, fill in details and give advice.');
  if (!DBX.connected()) steps.push('Connect <b>Dropbox</b> to keep your wines synced across devices and backed up daily.');
  if (!S.wines.size) steps.push('Bring in your existing wines with <b>Import data</b> (Settings), or tap <b>+ Log</b> and snap a label.');
  if (!steps.length) return '';
  let dismissed = false; try { dismissed = localStorage.getItem('cellarbook.welcomeHidden') === '1'; } catch (e) {}
  if (dismissed && S.wines.size) return '';
  return `<div class="welcome"><h2>Welcome to Cellar Book</h2><p class="hint" style="margin:0">A few things to set up on this device:</p>
    <ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>
    <div class="row"><button class="btn primary" type="button" data-opensettings>Open Settings</button>${S.wines.size ? '<button class="btn ghost" type="button" id="welcomeHide">Not now</button>' : ''}</div></div>`;
}

function renderJournal() {
  const el = $('#journalList');
  if (!S.loaded) { el.innerHTML = `<p class="thinking">Opening your cellar book…</p>`; return; }
  let list = [...S.wines.values()];
  if (S.rfilter === 'want') list = list.filter(w => w.wishlist);
  else {
    list = list.filter(isTasted);
    if (S.rfilter === 'unrated') list = list.filter(w => !RMAP[w.rating]);
    else if (S.rfilter !== 'all') list = list.filter(w => w.rating === S.rfilter);
  }
  if (S.cfilter !== 'all') list = list.filter(w => w.color === S.cfilter);
  const q = norm(S.q);
  if (q) list = list.filter(w => norm([w.producer, w.name, w.vintage, grapesOf(w).join(' '), w.region, w.country, w.appellation, w.notes].join(' ')).includes(q));
  const score = w => RMAP[w.rating]?.score ?? -1;
  const sorters = {
    recent: (a, b) => String(b.last_tasted || (b.tastings && b.tastings.length ? '0' : b.updated_at) || '').localeCompare(String(a.last_tasted || (a.tastings && a.tastings.length ? '0' : a.updated_at) || '')),
    rating: (a, b) => score(b) - score(a) || String(b.last_tasted || '').localeCompare(String(a.last_tasted || '')),
    vintage: (a, b) => (Number(b.vintage) || 0) - (Number(a.vintage) || 0),
    producer: (a, b) => String(a.producer || a.name || '').localeCompare(String(b.producer || b.name || '')),
  };
  list.sort(sorters[S.sort]);
  const welcome = welcomeCard();
  if (!S.wines.size) { el.innerHTML = welcome || emptyState('Your cellar book is empty', 'Tap <b>+ Log</b> and snap a label.'); return; }
  if (!list.length) {
    el.innerHTML = welcome + emptyState(S.rfilter === 'want' ? 'Nothing on your list yet' : 'No wines match', S.rfilter === 'want' ? 'Save picks from <b>Pick for me</b>, or log a wine as “Want to try”.' : 'Try a different search or filter.');
    return;
  }
  el.innerHTML = welcome + list.map(w => wineRow(w, S.rfilter === 'want'
    ? `<span class="rate r-want">Want to try</span>`
    : `${w.rating ? rateChip(w.rating) : '<span class="pill">Rate it</span>'}<span class="w-date">${esc(fmtDate(w.last_tasted))}</span>`)).join('');
}

/* ---------- Cellar ---------- */
function renderCellar() {
  const list = $('#cellarList'), sum = $('#cellarSummary');
  if (!S.loaded) { list.innerHTML = `<p class="thinking">Opening your cellar book…</p>`; sum.innerHTML = ''; return; }
  const ws = [...S.wines.values()].filter(w => (Number(w.bottles) || 0) > 0);
  const bottles = ws.reduce((a, w) => a + Number(w.bottles), 0);
  const value = ws.reduce((a, w) => a + Number(w.bottles) * (Number(w.paid) || Number(w.price_usd) || 0), 0);
  const ready = ws.filter(w => ['ready', 'soon', 'past'].includes(windowStatus(w)?.k)).reduce((a, w) => a + Number(w.bottles), 0);
  sum.innerHTML = `
    <div class="stat"><b>${bottles}</b><span>Bottles</span></div>
    <div class="stat"><b>${ws.length}</b><span>Wines</span></div>
    <div class="stat"><b>${ready}</b><span>Ready to drink</span></div>
    ${value ? `<div class="stat"><b>$${Math.round(value).toLocaleString()}</b><span>Est. value</span></div>` : ''}`;
  if (!ws.length) {
    list.innerHTML = emptyState('No bottles on hand', 'Tap <b>+ Add to cellar</b> and snap a label, or <b>Scan a list or receipt</b> to add many bottles at once.');
    return;
  }
  const groups = [
    ['Drink soon', w => ['soon', 'past'].includes(windowStatus(w)?.k)],
    ['Ready to drink', w => windowStatus(w)?.k === 'ready'],
    ['Holding', w => windowStatus(w)?.k === 'hold'],
    ['No window set', w => !windowStatus(w)],
  ];
  list.innerHTML = groups.map(([title, fn]) => {
    const g = ws.filter(fn).sort((a, b) => (parseInt(a.drink_to) || 9999) - (parseInt(b.drink_to) || 9999));
    if (!g.length) return '';
    const n = g.reduce((a, w) => a + Number(w.bottles), 0);
    return `<div class="group-h"><span>${title}</span><span class="num">${n} ${n === 1 ? 'bottle' : 'bottles'}</span></div>` + g.map(w => {
      const st = windowStatus(w);
      return `<div class="cellar-row">
        <span class="glass" style="--g:${colorVar(w.color)}"></span>
        <span class="w-main" data-open="${esc(w.id)}" role="button" tabindex="0">
          ${w.producer ? `<span class="w-prod">${esc(w.producer)}</span>` : ''}
          <span class="w-name">${esc(w.name || w.producer || 'Unnamed wine')}<span class="w-vint">${esc(w.vintage || 'NV')}</span></span>
          <span class="w-meta">${esc([w.location, placeOf(w)].filter(Boolean).join(' · '))}</span>
        </span>
        <span class="cellar-side">
          ${st ? `<span class="pill ${st.k}">${esc(st.label)}</span>` : ''}
          ${rateChip(w.rating)}
          <span class="qty">
            <button class="icon-btn" type="button" data-qty="-1" data-id="${esc(w.id)}" aria-label="Remove a bottle">−</button>
            <b>${Number(w.bottles)}</b>
            <button class="icon-btn" type="button" data-qty="1" data-id="${esc(w.id)}" aria-label="Add a bottle">+</button>
          </span>
          <button class="btn sm" type="button" data-openbottle="${esc(w.id)}">Open one</button>
        </span>
      </div>`;
    }).join('');
  }).join('');
}
function changeQty(id, delta) {
  const w = S.data.wines[id]; if (!w) return;
  patchWine(id, { bottles: Math.max(0, (Number(w.bottles) || 0) + delta) });
}

/* ---------- Palate ---------- */
function mixBar(counts, total) {
  if (!total) return `<div class="mix"></div>`;
  return `<div class="mix" role="img" aria-label="${RATINGS.map(r => `${counts[r.key] || 0} ${r.label}`).join(', ')}">${RATINGS.map(r => counts[r.key] ? `<span style="--c:var(--${r.key});width:${(counts[r.key] / total * 100).toFixed(2)}%"></span>` : '').join('')}</div>`;
}
function aggregate(rated, keysFn) {
  const m = new Map();
  for (const w of rated) {
    const seen = new Set();
    for (let k of keysFn(w)) {
      k = String(k || '').trim(); if (!k) continue;
      const key = k.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
      const e = m.get(key) || { name: k, n: 0, sum: 0, counts: {} };
      e.n++; e.sum += RMAP[w.rating].score; e.counts[w.rating] = (e.counts[w.rating] || 0) + 1;
      m.set(key, e);
    }
  }
  return [...m.values()].map(e => ({ ...e, avg: e.sum / e.n }));
}
function aggBlock(title, rows, minN) {
  const r = rows.filter(x => x.n >= minN).sort((a, b) => b.avg - a.avg || b.n - a.n).slice(0, 8);
  if (!r.length) return '';
  return `<div><h3 class="p-h">${title}</h3>${r.map(x => `<div class="agg-row"><span class="nm" title="${esc(x.name)}">${esc(x.name)}</span>${mixBar(x.counts, x.n)}<span class="n">${x.n}</span></div>`).join('')}</div>`;
}
function renderPalate() {
  const el = $('#palate');
  if (!S.loaded) { el.innerHTML = ''; return; }
  const rated = [...S.wines.values()].filter(w => RMAP[w.rating]);
  const p = S.data.profile;
  const profileHtml = `<div class="profile">
    <h3 class="p-h">Your palate, in words</h3>
    ${p && p.summary ? `
      <p class="lead">${esc(p.summary)}</p>
      <div class="profile-cols">
        ${p.loves?.length ? `<div><h3 class="p-h">You gravitate to</h3><ul>${p.loves.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${p.avoids?.length ? `<div><h3 class="p-h">You tend to skip</h3><ul>${p.avoids.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${p.try_next?.length ? `<div><h3 class="p-h">Try next</h3><ul>${p.try_next.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      </div>` : `<p class="prose" style="color:var(--muted)">${rated.length < 5 ? `Rate a few more wines (${rated.length} so far) and Claude will describe your taste here.` : 'No written profile yet. Ask Claude to write one from your ratings.'}</p>`}
    <div class="profile-foot">
      <span>${p?.updated_at ? `Updated ${esc(fmtDate(String(p.updated_at).slice(0, 10)))}${p.based_on ? ` from ${esc(p.based_on)} rated wines` : ''}` : ''}</span>
      ${hasClaude() && rated.length >= 5 ? `<button class="btn sm" type="button" id="profileBtn">${p?.summary ? 'Refresh with Claude' : 'Write it with Claude'}</button>` : ''}
    </div>
    <p class="status" id="profileStatus"></p>
  </div>`;
  if (!rated.length) { el.innerHTML = profileHtml + emptyState('Nothing rated yet', 'Your palate map fills in as you rate wines Love, Like, Meh or Dislike.'); return; }
  const counts = {}; rated.forEach(w => counts[w.rating] = (counts[w.rating] || 0) + 1);
  const minN = rated.length >= 20 ? 2 : 1;
  el.innerHTML = profileHtml + `
    <div>
      <h3 class="p-h">How it's gone · ${rated.length} rated</h3>
      ${mixBar(counts, rated.length)}
      <div class="legend">${RATINGS.map(r => `<span><span class="dot" style="--c:var(--${r.key})"></span>${r.label} <b>${counts[r.key] || 0}</b></span>`).join('')}</div>
      <div style="margin-top:24px">${aggBlock('By style', aggregate(rated, w => [CMAP[w.color]]), 1)}</div>
    </div>
    ${aggBlock('Grapes', aggregate(rated, grapesOf), minN)}
    ${aggBlock('Regions', aggregate(rated, w => [w.region || w.country]), minN)}
    ${aggBlock('Countries', aggregate(rated, w => [w.country]), minN)}
    ${aggBlock('Producers', aggregate(rated, w => [w.producer]), 2)}`;
}
function historyDigest(max = 300) {
  const rated = [...S.wines.values()].filter(w => RMAP[w.rating])
    .sort((a, b) => RMAP[b.rating].score - RMAP[a.rating].score || String(b.last_tasted || '').localeCompare(String(a.last_tasted || '')));
  return rated.slice(0, max).map(w => {
    const notes = [w.notes, ...(w.tastings || []).map(t => t.notes)].filter(Boolean).join(' / ').slice(0, 120);
    return `${w.rating.toUpperCase()} | ${wineLabel(w)} | ${CMAP[w.color] || ''} | ${grapesOf(w).join(', ')} | ${placeOf(w)}${notes ? ' | notes: ' + notes : ''}`;
  }).join('\n');
}
async function refreshProfile() {
  const btn = $('#profileBtn'), st = $('#profileStatus');
  btn.disabled = true; st.className = 'status'; st.textContent = 'Claude is reading your ratings…';
  const rated = [...S.wines.values()].filter(w => RMAP[w.rating]);
  try {
    const { data: out } = await askJSON(
`Write a wine taste profile for Varun from his ratings (LOVE > LIKE > MEH > DISLIKE). Be specific about styles, grapes, regions and structure (body, acidity, tannin, oak, sweetness, fruit vs. earth). Base everything on the data.

Reply with only JSON:
{"summary":"3-4 sentences, second person","loves":["5-7 short phrases"],"avoids":["2-5 short phrases"],"try_next":["4-6 specific wines or styles he has not logged, each with a short reason"]}

His wines:
${historyDigest()}`, { max_tokens: 1500 });
    if (!out || !out.summary) throw { code: 'bad_json', message: 'Claude’s answer came back garbled. Try again.' };
    setProfile({ summary: String(out.summary), loves: (out.loves || []).map(String), avoids: (out.avoids || []).map(String), try_next: (out.try_next || []).map(String), based_on: rated.length, source: 'app' });
    toast('Palate profile updated');
  } catch (e) { st.className = 'status err'; st.textContent = claudeErr(e); btn.disabled = false; }
}

/* ---------- Sheets ---------- */
function openSheet(id) { $('#scrim').hidden = false; $(id).hidden = false; document.body.style.overflow = 'hidden'; $(id).scrollTop = 0; }
function closeSheets() {
  $('#scrim').hidden = true;
  ['#detail', '#editor', '#settings', '#scanner'].forEach(s => { $(s).hidden = true; });
  document.body.style.overflow = '';
  S.detailId = null; S.ed = null; S.delArm = false;
}

/* ---------- Wine details ---------- */
function openDetail(id) {
  if (!S.wines.has(id)) return;
  S.detailId = id; S.delArm = false;
  ['#editor', '#settings', '#scanner'].forEach(s => { $(s).hidden = true; });
  renderDetail(); openSheet('#detail');
}
function storyHtml(w) {
  const st = w.story;
  const busy = S.storyBusy && S.storyBusy.has(w.id);
  const btn = hasClaude() ? `<button class="btn sm" type="button" data-story="${esc(w.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Writing…' : st ? 'Rewrite' : 'Write the story'}</button>` : '';
  if (!st) {
    return `<div class="sec"><div class="row" style="justify-content:space-between"><h3 style="margin:0">The story</h3>${btn}</div>
      <p class="hint" style="margin:8px 0 0">${busy ? 'Claude is researching the region, the winemaker and the terroir…' : hasClaude() ? 'Region history, the winemaker, climate and soils, and what makes this wine unique.' : 'Add your Claude API key in Settings to get the story behind each wine.'}</p></div>`;
  }
  const part = (h, t) => t ? `<h4>${h}</h4><p>${esc(t)}</p>` : '';
  return `<div class="sec story">
    <div class="row" style="justify-content:space-between;margin-bottom:8px"><h3 style="margin:0">The story</h3>${btn}</div>
    ${part('The region', st.region_history)}${part('The winemaker', st.producer)}${part('Climate', st.climate)}${part('Soils', st.soils)}${part('What makes it unique', st.unique)}${part('In the glass', st.in_the_glass)}
    ${st.sources && st.sources.length ? `<p class="src">Sources: ${st.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(' · ')}</p>` : ''}
  </div>`;
}
function renderDetail() {
  const w = S.wines.get(S.detailId);
  const el = $('#detail');
  if (!w) { closeSheets(); return; }
  const st = windowStatus(w);
  const tastings = [...(w.tastings || [])].map((t, i) => ({ ...t, i })).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const facts = [
    ['Style', CMAP[w.color]], ['Grapes', grapesOf(w).join(', ')], ['Region', placeOf(w)], ['Appellation', w.appellation],
    ['Body', w.body ? w.body[0].toUpperCase() + w.body.slice(1) : ''], ['Food', w.food_pairing],
    ['Drink window', (w.drink_from || w.drink_to) ? `${w.drink_from || '…'}–${w.drink_to || '…'}` : ''],
    ['Typical price', w.price_usd ? `$${w.price_usd}` : ''],
    ['Vivino average', w.vivino && w.vivino.avg_rating ? `${w.vivino.avg_rating} / 5` : ''],
  ].filter(([, v]) => v);
  const b = Number(w.bottles) || 0;
  el.innerHTML = `
    <div class="sheet-head">
      <span class="glass" style="--g:${colorVar(w.color)}"></span>
      <div style="display:flex;gap:6px"><button class="btn sm" type="button" id="dEdit">Edit</button><button class="btn ghost" type="button" data-close>Close</button></div>
    </div>
    <div class="sheet-body">
      ${w.label_photo ? `<img class="label-img" id="dPhoto" alt="Label photo" hidden>` : ''}
      ${w.producer ? `<div class="d-prod">${esc(w.producer)}</div>` : ''}
      <div class="d-name">${esc(w.name || w.producer || 'Unnamed wine')}<span class="w-vint">${esc(w.vintage || 'NV')}</span></div>
      <div class="d-line">${rateChip(w.rating)}${w.wishlist ? '<span class="rate r-want">Want to try</span>' : ''}
        ${tastings.length ? `<span>Tasted ${tastings.length}×${w.last_tasted ? ` · last ${esc(fmtDate(w.last_tasted))}` : ''}</span>` : ''}</div>

      <div class="sec">
        <div class="cellar-box">
          <div>
            <div class="lbl">In your cellar</div>
            <div class="qty" style="margin-top:6px">
              <button class="icon-btn" type="button" data-qty="-1" data-id="${esc(w.id)}" aria-label="Remove a bottle">−</button>
              <b>${b}</b>
              <button class="icon-btn" type="button" data-qty="1" data-id="${esc(w.id)}" aria-label="Add a bottle">+</button>
              <span class="hint">${esc(w.location || '')}</span>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            ${st ? `<span class="pill ${st.k}">${esc(st.label)}</span>` : ''}
            ${b > 0 ? `<button class="btn sm primary" type="button" data-openbottle="${esc(w.id)}">Open a bottle</button>` : ''}
            <button class="btn sm" type="button" id="dTaste">Log a tasting</button>
          </div>
        </div>
      </div>

      ${w.about || w.tasting_profile ? `<div class="sec">
        ${w.about ? `<h3>About</h3><p class="prose">${esc(w.about)}</p>` : ''}
        ${w.tasting_profile ? `<h3 style="margin-top:12px">How it typically tastes</h3><p class="prose">${esc(w.tasting_profile)}</p>` : ''}
      </div>` : ''}

      ${storyHtml(w)}

      ${facts.length ? `<div class="sec"><dl class="kv">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : ''}
      ${w.notes ? `<div class="sec"><h3>Your notes</h3><p class="prose">${esc(w.notes)}</p></div>` : ''}

      <div class="sec">
        <h3>Tastings</h3>
        ${tastings.length ? tastings.map(t => `<div class="t-row">
          <span class="dt">${esc(t.date ? fmtDate(t.date) : 'No date')}</span>${t.rating ? rateChip(t.rating) : '<span class="hint">Not rated</span>'}
          <span>${esc([t.notes, (t.place || t.where) && `(${t.place || t.where})`].filter(Boolean).join(' '))}${t.rating ? '' : `<span class="quick-rate">${RATINGS.map(r => `<button type="button" class="r-${r.key}" data-ratet="${t.i}:${r.key}">${r.label}</button>`).join('')}</span>`}</span>
          <button class="x" type="button" data-deltasting="${t.i}" aria-label="Remove this tasting">×</button>
        </div>`).join('') : `<p class="hint">Not tasted yet.</p>`}
      </div>

      <div class="sec" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span class="hint">Added ${esc(fmtDate(String(w.created_at || '').slice(0, 10)))}${w.source && w.source !== 'app' ? ` via ${esc(w.source)}` : ''}</span>
        <button class="btn sm danger" type="button" id="dDelete">${S.delArm ? 'Tap again to delete' : 'Delete wine'}</button>
      </div>
    </div>`;
  if (w.label_photo) photoUrl(w.label_photo).then(u => { const img = $('#dPhoto'); if (u && img) { img.src = u; img.hidden = false; } });
}

/* ---------- Logging form ---------- */
const PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';

function setupEditor() {
  $('#e-color').innerHTML = `<option value="">—</option>` + COLORS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('#edIntent').addEventListener('click', e => {
    const b = e.target.closest('[data-v]'); if (!b || !S.ed) return;
    setIntent(b.dataset.v);
  });
  $('#edRating').addEventListener('click', e => {
    const b = e.target.closest('[data-r]'); if (!b || !S.ed) return;
    S.ed.rating = S.ed.rating === b.dataset.r ? null : b.dataset.r; // tap again to clear
    $$('#edRating [data-r]').forEach(x => x.setAttribute('aria-pressed', x.dataset.r === S.ed.rating));
  });
  $('#edPhoto').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0]; if (!f || !S.ed) return;
    e.target.value = '';
    onLabelPhoto(f);
  });
  $('#edLookupBtn').addEventListener('click', () => {
    const t = $('#edLookup').value.trim();
    if (t) identify({ text: t }); else $('#edLookup').focus();
  });
  $('#edLookup').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#edLookupBtn').click(); } });
  $('#edLoc').addEventListener('click', e => {
    if (!S.ed) return;
    if (e.target.closest('[data-locrm]')) { S.ed.loc = null; S.ed.locState = 'removed'; renderLoc(); }
    if (e.target.closest('[data-locnow]')) captureLiveLocation(true);
  });
  $('#edScanList').addEventListener('click', () => openScanner(S.ed && S.ed.intent === 'bought' ? 'cellar' : 'cellar'));
  $('#edSave').addEventListener('click', saveEditor);
}

function setIntent(v) {
  S.ed.intent = v;
  $$('#edIntent [data-v]').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === v));
  if (v === 'bought' && !(parseInt($('#e-bottles').value) > 0)) $('#e-bottles').value = 1;
  if (v === 'drank' && S.ed.mode === 'new' && !S.ed.loc && S.ed.locState == null && settings.saveLocation) captureLiveLocation(false);
  edVisibility();
}

function fillFields(w) {
  $('#e-producer').value = w.producer || '';
  $('#e-name').value = w.name || '';
  $('#e-vintage').value = w.vintage || '';
  $('#e-color').value = CMAP[w.color] ? w.color : '';
  $('#e-grapes').value = grapesOf(w).join(', ');
  $('#e-region').value = w.region || '';
  $('#e-country').value = w.country || '';
  $('#e-appellation').value = w.appellation || '';
  $('#e-body').value = ['light', 'medium', 'full'].includes(w.body) ? w.body : '';
  $('#e-profile').value = w.tasting_profile || '';
  $('#e-food').value = w.food_pairing || '';
  $('#e-from').value = w.drink_from || '';
  $('#e-to').value = w.drink_to || '';
  $('#e-price').value = w.price_usd || '';
  $('#e-about').value = w.about || '';
}
function readFields() {
  const v = id => $('#e-' + id).value.trim();
  const num = s => { const n = parseFloat(String(s).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; };
  const vint = parseInt(v('vintage'));
  return {
    producer: v('producer'), name: v('name'), vintage: vint >= 1800 && vint <= 2100 ? vint : null,
    color: v('color') || null, grapes: v('grapes').split(',').map(s => s.trim()).filter(Boolean),
    region: v('region'), country: v('country'), appellation: v('appellation'), body: v('body') || null,
    tasting_profile: v('profile'), food_pairing: v('food'), drink_from: parseInt(v('from')) || null,
    drink_to: parseInt(v('to')) || null, price_usd: num(v('price')), about: v('about'),
  };
}

function openEditor(mode, wineId, opts = {}) {
  S.ed = { mode, id: wineId || null, intent: opts.intent || 'drank', rating: null, openBottle: !!opts.openBottle, loc: null, locState: null, origin: null, photoBlob: null, filled: null };
  ['#detail', '#settings', '#scanner'].forEach(s => { $(s).hidden = true; });
  const w = wineId ? S.wines.get(wineId) : null;
  fillFields(w || {});
  $('#edLookup').value = ''; $('#edThumb').innerHTML = ''; $('#edStatus').textContent = ''; $('#edStatus').className = 'status';
  $('#edSaveStatus').textContent = ''; $('#edSaveStatus').className = 'status';
  $('#e-tnotes').value = ''; $('#e-date').value = today(); $('#e-where').value = '';
  $('#e-bottles').value = mode === 'edit' ? (Number(w?.bottles) || 0) : (S.ed.intent === 'bought' ? 1 : 0);
  $('#e-location').value = w?.location || '';
  $('#e-paid').value = w?.paid || '';
  $('#e-notes').value = w?.notes || '';
  $('#edMore').open = mode === 'edit';
  $$('#edRating [data-r]').forEach(x => x.setAttribute('aria-pressed', 'false'));
  $$('#edIntent [data-v]').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === S.ed.intent));
  $('#edTitle').textContent = mode === 'new' ? (S.ed.intent === 'bought' ? 'Add to cellar' : 'Log a wine') : mode === 'taste' ? (opts.openBottle ? 'Opening a bottle' : 'Log a tasting') : 'Edit wine';
  if (mode === 'taste' && w) {
    $('#edWineSummary').innerHTML = `${w.producer ? `<div class="d-prod">${esc(w.producer)}</div>` : ''}<div class="d-name" style="font-size:24px">${esc(w.name || w.producer)}<span class="w-vint">${esc(w.vintage || 'NV')}</span></div>`;
  }
  edVisibility(); renderLoc();
  openSheet('#editor');
  if (mode === 'taste' && settings.saveLocation) captureLiveLocation(false);
}

function edVisibility() {
  const { mode, intent } = S.ed;
  $('#edWineSummary').hidden = mode !== 'taste';
  $('#edIntentSec').hidden = mode !== 'new';
  $('#edIdentify').hidden = mode !== 'new';
  $('#edLookupRow').hidden = !hasClaude();
  $('#edPhotoNote').innerHTML = hasClaude()
    ? 'Claude reads the label and fills everything in. You can edit before saving.'
    : 'Add your Claude API key in <a href="#" data-opensettings>Settings</a> so photos fill in automatically. You can still fill in the form yourself.';
  $('#edInfo').hidden = mode === 'taste';
  $('#edTake').hidden = !(mode === 'taste' || (mode === 'new' && intent === 'drank'));
  $('#edCellar').hidden = !(mode === 'edit' || (mode === 'new' && intent !== 'want'));
  $('#e-bottles-l').textContent = mode === 'edit' ? 'Bottles on hand' : 'Bottles to add';
  $('#edCellarH').textContent = mode === 'new' && intent === 'drank' ? 'Have more at home?' : 'Cellar';
  $('#edNotesSec').hidden = mode !== 'edit';
}

function renderLoc() {
  const el = $('#edLoc'); if (!S.ed) return;
  const st = S.ed.locState, loc = S.ed.loc;
  el.hidden = false;
  if (st === 'reading') el.innerHTML = `${PIN}<span>Finding your location…</span>`;
  else if (loc) el.innerHTML = `${PIN}<span>${loc.src === 'photo' ? 'Location from photo' : 'You’re at'}${loc.place ? `: <b>${esc(loc.place)}</b>` : ''}</span><button type="button" data-locrm>Remove</button>`;
  else if (st === 'removed') el.innerHTML = `${PIN}<span>Location removed.</span><button type="button" data-locnow>Use my location</button>`;
  else if (st === 'denied') el.innerHTML = `${PIN}<span>Location unavailable. Type where you are below, or allow location for this app in iPhone Settings.</span>`;
  else el.innerHTML = `${PIN}<span>No location yet.</span><button type="button" data-locnow>Use my location</button>`;
}
async function captureLiveLocation(force) {
  if (!S.ed || (!force && !settings.saveLocation)) return;
  const ed = S.ed;
  ed.locState = 'reading'; renderLoc();
  const pos = await currentPosition();
  if (S.ed !== ed) return;
  if (!pos) { ed.locState = 'denied'; renderLoc(); return; }
  if (ed.loc && ed.loc.src === 'photo') { ed.locState = 'done'; renderLoc(); return; }
  ed.loc = { ...pos, place: '', src: 'live' }; ed.locState = 'done'; renderLoc();
  const place = await reverseGeocode(pos.lat, pos.lng);
  if (S.ed === ed && ed.loc && place) { ed.loc.place = place; if (!$('#e-where').value.trim()) $('#e-where').value = place.split(',')[0]; renderLoc(); }
}

async function onLabelPhoto(f) {
  const ed = S.ed;
  $('#edThumb').innerHTML = `<figure><img alt="Label photo" src="${URL.createObjectURL(f)}"></figure>`;
  ed.photoBlob = shrinkImage(f);
  const meta = await readPhotoMeta(f);
  if (S.ed !== ed) return;
  if (meta.date && meta.date !== today()) $('#e-date').value = meta.date;
  if (meta.gps && (meta.date && meta.date !== today() || !ed.loc)) {
    ed.loc = { ...meta.gps, place: '', src: 'photo' }; ed.locState = 'done'; renderLoc();
    reverseGeocode(meta.gps.lat, meta.gps.lng).then(p => { if (S.ed === ed && ed.loc && p) { ed.loc.place = p; if (!$('#e-where').value.trim()) $('#e-where').value = p.split(',')[0]; renderLoc(); } });
  } else if (!ed.loc && settings.saveLocation && ed.intent === 'drank') captureLiveLocation(false);
  if (hasClaude()) identify({ image: await ed.photoBlob });
}

async function identify({ image, text }) {
  if (!hasClaude()) return;
  const ed = S.ed;
  const st = $('#edStatus');
  st.className = 'status'; st.textContent = image ? 'Claude is reading the label…' : 'Looking it up…';
  $('#edLookupBtn').disabled = true;
  try {
    const { data: out } = await askJSON(labelPrompt({ image: !!image, text }), { images: image ? [image] : [], max_tokens: 1200 });
    if (!out || (!out.producer && !out.name)) throw { code: 'bad_json', message: 'Claude couldn’t make out the wine. Try a closer, sharper photo, or type the name.' };
    if (S.ed !== ed) return;
    fillFields(out);
    if (isFinite(parseFloat(out.origin_lat)) && isFinite(parseFloat(out.origin_lng)) && out.origin_lat !== null) ed.origin = { lat: +parseFloat(out.origin_lat).toFixed(3), lng: +parseFloat(out.origin_lng).toFixed(3) };
    ed.filled = true;
    const m = findMatch(readFields());
    st.textContent = (out.confidence === 'low' ? 'Best guess filled in. Please double-check. ' : 'Filled in. Edit anything, then save. ')
      + (m ? `You’ve logged this wine before (${m.rating ? RMAP[m.rating].label : 'unrated'}); saving adds to it.` : '');
  } catch (e) {
    if (S.ed === ed) { st.className = 'status err'; st.textContent = claudeErr(e); }
  } finally { $('#edLookupBtn').disabled = false; }
}

async function saveEditor() {
  if (!S.ed) return;
  const ed = S.ed;
  const st = $('#edSaveStatus'); st.className = 'status'; st.textContent = '';
  const { mode, intent } = ed;
  const num = s => { const n = parseFloat(String(s).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; };
  let id, w, isNew = false;
  if (mode === 'taste') {
    id = ed.id; w = clone(S.data.wines[id]);
  } else {
    const f = readFields();
    if (!f.producer && !f.name) { st.className = 'status err'; st.textContent = hasClaude() && ed.photoBlob ? 'Wait for Claude to finish reading the label, or type the wine name.' : 'Add a producer or wine name first.'; return; }
    if (mode === 'new') {
      const m = findMatch(f);
      if (m) { id = m.id; w = clone(S.data.wines[id]); for (const [k, v] of Object.entries(f)) if (v !== null && v !== '' && !(Array.isArray(v) && !v.length)) w[k] = v; }
      else { id = newId(f); w = blankWine(f); isNew = true; }
    } else { id = ed.id; w = { ...clone(S.data.wines[id]), ...f }; }
  }
  const takes = mode === 'taste' || (mode === 'new' && intent === 'drank');
  if (takes) {
    const t = { date: $('#e-date').value || today(), rating: ed.rating || null };
    const n = $('#e-tnotes').value.trim(); if (n) t.notes = n;
    const wh = $('#e-where').value.trim(); if (wh) t.where = wh;
    if (ed.loc) { t.lat = ed.loc.lat; t.lng = ed.loc.lng; t.place = ed.loc.place || wh || ''; }
    else if (wh) { const g = await geocode(wh); if (g) { t.lat = g.lat; t.lng = g.lng; t.place = wh; t.loc_est = true; } }
    if (S.ed !== ed) return;
    w.tastings = [...(w.tastings || []), t];
    w.wishlist = false;
    recalc(w);
  }
  if (mode === 'new' && intent === 'want') w.wishlist = true;
  if (mode === 'new' && intent !== 'want') {
    const add = Math.max(0, parseInt($('#e-bottles').value) || 0);
    w.bottles = (Number(w.bottles) || 0) + add;
    if (add) w.wishlist = false;
    const loc = $('#e-location').value.trim(); if (loc) w.location = loc;
    const paid = num($('#e-paid').value); if (paid !== null) w.paid = paid;
  }
  if (mode === 'edit') {
    w.bottles = Math.max(0, parseInt($('#e-bottles').value) || 0);
    w.location = $('#e-location').value.trim();
    w.paid = num($('#e-paid').value);
    w.notes = $('#e-notes').value.trim();
  }
  if (ed.origin && !(w.origin && isFinite(w.origin.lat))) w.origin = ed.origin;
  if (mode === 'taste' && ed.openBottle) w.bottles = Math.max(0, (Number(w.bottles) || 0) - 1);
  if (ed.photoBlob && !w.label_photo) { try { w.label_photo = await savePhoto(await ed.photoBlob); } catch (e) {} }
  if (isNew && !ed.filled && hasClaude()) w.needs_details = true;
  if (isNew && settings.autoStory && hasClaude()) w.needs_story = true;
  putWine(id, w);
  toast(mode === 'edit' ? 'Saved' : takes ? (ed.rating ? 'Logged' : 'Logged — rate it any time') : intent === 'want' ? 'Added to Want to try' : `Added to your cellar`);
  closeSheets();
}

/* ---------- Settings ---------- */
function renderSettings() {
  const body = $('#settingsBody');
  const dbxOn = DBX.connected();
  const n = S.wines.size;
  const noStory = [...S.wines.values()].filter(w => !w.story).length;
  body.innerHTML = `
  <div class="set-group">
    <h3>Claude</h3>
    <p class="hint" style="margin-top:0">Your API key stays on this device. Get one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> and set a monthly spending limit there.</p>
    <div class="row"><input id="setKey" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(settings.apiKey)}" aria-label="Claude API key"><button class="btn sm" type="button" id="setKeySave">Save &amp; test</button></div>
    <p class="status" id="setKeyStatus">${settings.apiKey ? 'Key saved on this device.' : ''}</p>
    <div class="field" style="margin-top:8px"><label for="setModel">Model</label><select id="setModel">${MODELS.map(([k, l]) => `<option value="${k}" ${settings.model === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <label class="toggle"><input type="checkbox" id="setSearch" ${settings.webSearch ? 'checked' : ''}><span>Let Claude search the web when writing a wine’s story <span class="hint">(more accurate for small producers; about 1–4¢ per story)</span></span></label>
    <label class="toggle"><input type="checkbox" id="setAutoStory" ${settings.autoStory ? 'checked' : ''}><span>Write the story automatically for new wines</span></label>
  </div>
  <div class="set-group">
    <h3>Location</h3>
    <label class="toggle"><input type="checkbox" id="setLoc" ${settings.saveLocation ? 'checked' : ''}><span>Save where I am when I log a tasting <span class="hint">(your iPhone asks permission the first time)</span></span></label>
  </div>
  <div class="set-group">
    <h3>Dropbox sync</h3>
    ${dbxOn ? `<p style="margin-top:0"><span class="ok-text">Connected.</span> ${settings.lastSync ? `Last synced ${esc(timeAgo(settings.lastSync))}.` : ''} Files are in your Dropbox under <b>Apps › ${esc(settings.dbxAppName || 'your Cellar Book app')}</b>. A backup copy is saved once a day.</p>
      <div class="row"><button class="btn sm primary" type="button" id="dbxSync">Sync now</button><button class="btn sm ghost" type="button" id="dbxOff">Disconnect</button></div>`
    : `<p class="hint" style="margin-top:0">Keeps your wines and label photos in your Dropbox, synced between devices, with a daily backup. See the setup guide for creating your Dropbox app key (one time, about 3 minutes).</p>
      <div class="field"><label for="dbxKey">Dropbox app key</label><div class="row"><input id="dbxKey" autocomplete="off" value="${esc(settings.dbxAppKey)}" placeholder="e.g. a1b2c3d4e5f6g7h"><button class="btn sm" type="button" id="dbxStart">Connect</button></div></div>
      <div id="dbxStep2" ${S.dbxUrl ? '' : 'hidden'}>
        <p class="hint"><b>1.</b> Open Dropbox, sign in if asked, tap <b>Allow</b>, then copy the code it shows.</p>
        <a class="btn sm primary" id="dbxOpen" href="${esc(S.dbxUrl || '#')}" target="_blank" rel="noopener">Open Dropbox</a>
        <p class="hint"><b>2.</b> Come back to Cellar Book and paste the code here:</p>
        <div class="row"><input id="dbxCode" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the code"><button class="btn sm primary" type="button" id="dbxFinish">Finish</button></div>
      </div>`}
    <p class="status" id="dbxStatus"></p>
  </div>
  <div class="set-group">
    <h3>Your data</h3>
    <p class="hint" style="margin-top:0">${n} wines on this device.</p>
    <div class="row">
      <label class="btn sm" for="importFile" style="cursor:pointer">Import data…</label>
      <input id="importFile" type="file" accept="application/json,.json" hidden>
      <button class="btn sm" type="button" id="exportBtn">Export a copy</button>
    </div>
    <p class="status" id="dataStatus"></p>
    ${hasClaude() && noStory ? `<div class="row" style="margin-top:10px"><button class="btn sm" type="button" id="storyAll">Write stories for ${noStory} ${noStory === 1 ? 'wine' : 'wines'}</button><span class="hint">Roughly ${Math.max(1, Math.round(noStory * (settings.webSearch ? 0.05 : 0.02)))} USD of API usage, runs in the background.</span></div>` : ''}
  </div>
  <div class="set-group"><p class="hint small" style="margin:0">Cellar Book ${APP_VERSION} · Data stays on your devices and in your Dropbox. Map data © OpenStreetMap contributors.</p></div>`;
}
function openSettings() { ['#detail', '#editor', '#scanner'].forEach(s => { $(s).hidden = true; }); renderSettings(); openSheet('#settings'); }

async function onSettingsClick(e) {
  const t = e.target;
  if (t.closest('#setKeySave')) {
    settings.apiKey = $('#setKey').value.trim(); saveSettings();
    const st = $('#setKeyStatus'); st.className = 'status'; st.textContent = 'Testing…';
    try {
      await claudeCall({ messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 5 });
      st.className = 'status ok-text'; st.textContent = 'Key works. Claude is ready.';
      renderAll(); kickQueue();
    } catch (err) { st.className = 'status err'; st.textContent = claudeErr(err); }
  }
  if (t.closest('#dbxStart')) {
    settings.dbxAppKey = $('#dbxKey').value.trim(); saveSettings();
    const st = $('#dbxStatus');
    try {
      if (!settings.dbxAppKey) throw new Error('Paste your Dropbox app key first.');
      // iPhone Safari blocks tabs opened by script after a delay, so show a link to tap instead.
      S.dbxUrl = await DBX.beginAuth();
      $('#dbxOpen').href = S.dbxUrl; $('#dbxStep2').hidden = false;
      st.className = 'status'; st.textContent = '';
      $('#dbxOpen').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) { st.className = 'status err'; st.textContent = err.message; }
  }
  if (t.closest('#dbxFinish')) {
    const st = $('#dbxStatus'); st.className = 'status'; st.textContent = 'Connecting…';
    try {
      await DBX.finishAuth($('#dbxCode').value);
      S.dbxUrl = null;
      st.textContent = 'Connected. Syncing…';
      await syncNow();
      renderSettings(); toast('Dropbox connected');
    } catch (err) { st.className = 'status err'; st.textContent = err.message; }
  }
  if (t.closest('#dbxSync')) { await syncNow(); renderSettings(); }
  if (t.closest('#dbxOff')) { DBX.disconnect(); renderSettings(); renderSyncChip(); }
  if (t.closest('#exportBtn')) {
    const blob = new Blob([JSON.stringify({ app: 'cellar-book', version: 1, ...S.data, exported_at: nowIso() }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `cellar-book-${today()}.json`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  if (t.closest('#storyAll')) {
    for (const w of S.wines.values()) if (!w.story) S.data.wines[w.id].needs_story = true;
    changed(); kickQueue(); toast('Writing stories in the background'); renderSettings();
  }
}
function onSettingsChange(e) {
  const t = e.target;
  if (t.id === 'setModel') { settings.model = t.value; saveSettings(); }
  if (t.id === 'setSearch') { settings.webSearch = t.checked; saveSettings(); }
  if (t.id === 'setAutoStory') { settings.autoStory = t.checked; saveSettings(); }
  if (t.id === 'setLoc') { settings.saveLocation = t.checked; saveSettings(); }
  if (t.id === 'importFile' && t.files && t.files[0]) importFile(t.files[0]);
}
async function importFile(file) {
  const st = $('#dataStatus'); st.className = 'status'; st.textContent = 'Importing…';
  try {
    const j = JSON.parse(await file.text());
    if (!j || typeof j.wines !== 'object') throw new Error('That file doesn’t look like a Cellar Book export.');
    const photos = j.photos || {};
    for (const [pid, dataUrl] of Object.entries(photos)) await IDB.put('photos', pid, { blob: dataUrlToBlob(dataUrl), uploaded: false, at: nowIso() });
    const incoming = { wines: {}, deleted: j.deleted || {}, profile: j.profile || null };
    for (const [id, w] of Object.entries(j.wines)) { const { id: _d, ...b } = w; incoming.wines[id] = { ...b, updated_at: b.updated_at || nowIso() }; }
    if (incoming.profile && !incoming.profile.updated_at) incoming.profile.updated_at = nowIso();
    const before = S.wines.size;
    S.data = mergeData(S.data, incoming);
    changed();
    st.className = 'status ok-text'; st.textContent = `Imported. You now have ${S.wines.size} wines (${S.wines.size - before} new).`;
  } catch (err) { st.className = 'status err'; st.textContent = err.message || 'Import failed.'; }
}

/* ---------- Tabs, clicks, startup ---------- */
function setTab(t) {
  S.tab = t;
  $$('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
  TABS.forEach(k => { $('#v-' + k).hidden = k !== t; });
  try { localStorage.setItem('cellarbook.tab', t); } catch (e) {}
  renderView();
}
function renderView() {
  if (S.tab === 'journal') renderJournal();
  else if (S.tab === 'cellar') renderCellar();
  else if (S.tab === 'palate') renderPalate();
  else if (S.tab === 'ask') { if (!S.chatBusy) renderChat(); }
  else if (S.tab === 'map') renderMap();
  else if (S.tab === 'pick') { if (!S.pickResult) renderPickIntro(); }
}
function renderAll() {
  renderHeader(); renderView();
  if (S.detailId && !$('#detail').hidden) renderDetail();
}

document.addEventListener('click', e => {
  const t = e.target;
  const tab = t.closest('.tabs [data-tab]'); if (tab) return setTab(tab.dataset.tab);
  if (t.closest('[data-close]') || t.id === 'scrim') return closeSheets();
  if (t.closest('[data-opensettings]')) { e.preventDefault(); return openSettings(); }
  if (t.closest('#settingsBtn') || t.closest('#syncChip')) return openSettings();
  if (t.closest('#settings')) return onSettingsClick(e);
  const q = t.closest('[data-qty]'); if (q) { e.stopPropagation(); return changeQty(q.dataset.id, +q.dataset.qty); }
  const ob = t.closest('[data-openbottle]'); if (ob) return openEditor('taste', ob.dataset.openbottle, { openBottle: true });
  const op = t.closest('[data-open]'); if (op) return openDetail(op.dataset.open);
  const sty = t.closest('[data-story]'); if (sty) return writeStory(sty.dataset.story, true);
  if (t.closest('#logBtn') || t.closest('#cellarAddBtn')) {
    const intent = (S.tab === 'cellar' || t.closest('#cellarAddBtn')) ? 'bought' : 'drank';
    openEditor('new', null, { intent });
    if (window.matchMedia('(hover: none)').matches) { try { $('#edPhoto').click(); } catch (err) {} }
    return;
  }
  if (t.closest('#cellarScanBtn')) return openScanner('cellar');
  if (t.closest('#welcomeHide')) { try { localStorage.setItem('cellarbook.welcomeHidden', '1'); } catch (err) {} return renderJournal(); }
  if (t.closest('#dEdit')) return openEditor('edit', S.detailId);
  if (t.closest('#dTaste')) return openEditor('taste', S.detailId);
  if (t.closest('#profileBtn')) return refreshProfile();
  const qr = t.closest('[data-ratet]');
  if (qr && S.detailId) {
    const [ti, rk] = qr.dataset.ratet.split(':');
    const w = clone(S.data.wines[S.detailId]);
    if (w.tastings && w.tastings[+ti]) { w.tastings[+ti].rating = rk; recalc(w); putWine(S.detailId, w); toast(`Rated ${RMAP[rk].label}`); }
    return;
  }
  const dt = t.closest('[data-deltasting]');
  if (dt && S.detailId) {
    const w = clone(S.data.wines[S.detailId]);
    w.tastings.splice(+dt.dataset.deltasting, 1); recalc(w); putWine(S.detailId, w); toast('Tasting removed');
    return;
  }
  if (t.closest('#dDelete') && S.detailId) {
    if (!S.delArm) { S.delArm = true; renderDetail(); return; }
    deleteWine(S.detailId); toast('Wine deleted'); closeSheets();
  }
  if (typeof onFeatureClick === 'function') onFeatureClick(e);
});
document.addEventListener('change', e => { if (e.target.closest('#settings')) onSettingsChange(e); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && ['#detail', '#editor', '#settings', '#scanner'].some(s => !$(s).hidden)) closeSheets();
  if (e.key === 'Enter' && e.target.matches('[data-open][role=button]')) openDetail(e.target.dataset.open);
});

async function boot() {
  setupJournalControls(); setupEditor(); setupPick(); setupChat(); setupMap(); setupScanner();
  let saved = null; try { saved = localStorage.getItem('cellarbook.tab'); } catch (e) {}
  setTab(TABS.includes(saved) ? saved : 'journal');
  try {
    const st = await IDB.get('state', 'main');
    if (st && st.wines) S.data = { wines: st.wines, profile: st.profile || null, deleted: st.deleted || {}, updated_at: st.updated_at || null };
  } catch (e) { toast('This browser blocked local storage. Data won’t be kept.'); }
  rebuildIndex(); S.loaded = true;
  renderAll();
  if (DBX.connected()) syncNow();
  kickQueue();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
window.addEventListener('DOMContentLoaded', boot);
