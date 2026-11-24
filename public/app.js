// Garage SPA (vanilla JS, no build step). Hash routes:
//   #/  garage select | #/car/<id>/<tab> | #/due | #/inbox | #/settings | #/new-car | #/receipt/<id> | #/diagnose/<car>[/<todo>] | #/diag/<session>
import { carSvg, BODY_LABELS } from './cars.js';
import { CarViewer, webglAvailable } from './car3d.js';

const app = document.getElementById('app');
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// href for a link that came from research / AI / the web: http(s) only, escaped (anything else becomes a dead link)
const hu = u => /^https?:\/\//i.test(String(u ?? '').trim()) ? h(String(u).trim()) : '#';
const miles = n => (n == null ? '—' : `${Number(n).toLocaleString('en-US')} mi`);
const money = c => (c == null ? '' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const ymm = c => [c.year, c.make, c.model, c.trim && !/\(/.test(c.trim) ? c.trim : null].filter(Boolean).join(' ');
const fmtDate = d => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const fmtTs = s => new Date(s * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const HAS_GL = webglAvailable();
let ME = null, TODAY = null, CONFIG = { app_name: 'Garage', auth_mode: 'password', integrations: [], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
const hasInt = k => (CONFIG.integrations || []).includes(k);
const DISCLAIMER_TEXT = 'Not professional advice. This information comes from AI and online research, not a certified mechanic. Verify before acting, follow safety precautions, and do all work at your own risk.';
const disclaimerNote = (cls = '') => `<p class="disclaimer-note small muted ${cls}">${h(CONFIG.disclaimer || DISCLAIMER_TEXT)}</p>`;

// ---------------------------------------------------------------- API
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  if (opts.raw) { init.headers['Content-Type'] = opts.raw.type || 'application/octet-stream'; init.headers['X-Filename'] = encodeURIComponent(opts.raw.name || 'file'); init.body = opts.raw; }
  const r = await fetch(path, init);
  if (r.status === 401) { location.href = `/auth/login?next=${encodeURIComponent(location.pathname + location.hash)}`; throw new Error('Signed out'); }
  if (opts.stream) { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r; }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

let toastTimer;
function toast(msg, ok = false) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = `toast${ok ? ' ok' : ''}`; t.textContent = msg; t.setAttribute('role', 'status');
  document.body.appendChild(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 4000);
}
const safe = fn => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };

// ---------------------------------------------------------------- modal + forms
function modal(title, bodyHtml, { submit = 'Save', danger = false, onSubmit, onOpen, wide = false } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<form class="modal" style="${wide ? 'max-width:760px' : ''}" novalidate><h2>${h(title)}</h2>${bodyHtml}
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button>${submit ? `<button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${h(submit)}</button>` : ''}</div></form>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  const form = back.querySelector('form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try { if ((await onSubmit?.(formData(form), form)) !== false) close(); }
    catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  });
  document.body.appendChild(back);
  onOpen?.(form);
  form.querySelector('input,textarea,select')?.focus();
  return { close, form };
}
function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.type === 'file') continue;
    if (el.type === 'checkbox') { if (el.dataset.multi) { (o[el.name] ||= []); if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked; }
    else o[el.name] = el.value;
  }
  return o;
}
const field = (label, name, value = '', type = 'text', extra = '') =>
  `<div class="field"><label for="f-${name}">${h(label)}</label><input id="f-${name}" name="${name}" type="${type}" value="${h(value)}" ${extra}></div>`;
const area = (label, name, value = '', extra = '') =>
  `<div class="field"><label for="f-${name}">${h(label)}</label><textarea id="f-${name}" name="${name}" ${extra}>${h(value)}</textarea></div>`;

// ---------------------------------------------------------------- symptoms
const KINDS = { noise: 'Noise', smell: 'Smell', leak: 'Leak', warning_light: 'Warning light', handling: 'Drives / handles weird', no_start: "Won't start", other: 'Other' };
const WHENS = { cold_start: 'Cold start', warm: 'Warmed up', idle: 'Idle', accelerating: 'Accelerating', braking: 'Braking', turning: 'Turning', highway: 'Highway', bumps: 'Over bumps', always: 'All the time' };
const WHERES = { front: 'Front', back: 'Back', left: 'Left', right: 'Right', under_hood: 'Under the hood', inside: 'Inside the car' };
const symptomBtn = (carId = '', extra = '') => `<button type="button" class="btn symptom-btn ${extra}" data-symptom="${h(carId)}"><span aria-hidden="true">＋</span> Add a new symptom</button>`;
const chipGroup = (group, dict) => `<div class="chips" role="group" aria-label="${group}">${Object.entries(dict).map(([k, l]) => `<button type="button" class="chip-toggle" data-group="${group}" data-val="${k}" aria-pressed="false">${h(l)}</button>`).join('')}</div>`;

async function openSymptomForm(carId) {
  const { cars } = await api('/api/cars');
  if (!cars.length) return toast('Add a car first');
  const sel = cars.find(c => c.id === carId) || (carId ? null : cars.find(c => c.id === store.get('garage.car'))) || cars[0];
  modal('Add a new symptom', `
    <div class="field"><label for="f-car">Which car?</label><select id="f-car" name="car_id">${cars.map(c => `<option value="${c.id}" ${c.id === sel.id ? 'selected' : ''}>${h(c.nickname)} (${h(ymm(c))})</option>`).join('')}</select></div>
    <div class="field"><label for="f-desc">What's happening?</label><textarea id="f-desc" name="description" rows="4" required maxlength="4000" placeholder="e.g. squealing when I brake, worse in the morning"></textarea></div>
    <div class="field"><label>What kind of problem? <span class="muted">(optional)</span></label>${chipGroup('kind', KINDS)}</div>
    <div class="field"><label>When does it happen? <span class="muted">(optional)</span></label>${chipGroup('when', WHENS)}</div>
    <div class="field"><label>Where does it seem to come from? <span class="muted">(optional)</span></label>${chipGroup('where', WHERES)}</div>
    <div class="row"><div class="field"><label for="f-miles">Mileage now <span class="muted">(optional)</span></label><input id="f-miles" name="mileage" type="number" inputmode="numeric" min="0" value="${sel.mileage ?? ''}"></div>
      <div class="field"><label for="f-media">Photo or short video <span class="muted">(optional)</span></label><input id="f-media" type="file" accept="image/*,video/*" multiple></div></div>
    ${CONFIG.ai === false ? '' : '<p class="small muted">After you save, the AI mechanic adds the first things to check, cheapest first.</p>'}`, {
    submit: 'Save symptom',
    onOpen: f => {
      f.querySelectorAll('.chip-toggle').forEach(b => b.onclick = () => b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'));
      f.querySelector('#f-car').onchange = e => { const c = cars.find(x => x.id === e.target.value); f.querySelector('#f-miles').value = c?.mileage ?? ''; };
      f.querySelector('#f-desc').focus();
    },
    onSubmit: async (data, f) => {
      if (!data.description.trim()) { toast("Tell us what's happening"); return false; }
      const picked = g => [...f.querySelectorAll(`.chip-toggle[data-group="${g}"][aria-pressed="true"]`)].map(b => b.dataset.val);
      const r = await api(`/api/cars/${data.car_id}/symptoms`, { method: 'POST', body: { description: data.description, kind: picked('kind'), when: picked('when'), where: picked('where'), mileage: data.mileage } });
      if (!r.duplicate) for (const file of f.querySelector('#f-media').files) await api(`/api/todos/${r.id}/files`, { method: 'POST', raw: file });
      toast(r.duplicate ? 'That one is already on the list' : CONFIG.ai === false ? 'Saved' : 'Saved. The mechanic is looking at it…', true);
      if (location.hash === `#/car/${data.car_id}/todo`) render(); else location.hash = `#/car/${data.car_id}/todo`;
    },
  });
}
document.addEventListener('click', e => { const b = e.target.closest('[data-symptom]'); if (b) { e.preventDefault(); safe(openSymptomForm)(b.dataset.symptom); } });

// ---------------------------------------------------------------- bottom sheet (multi-step pickers)
function sheet(title) {
  const back = document.createElement('div');
  back.className = 'modal-back sheet-back';
  back.innerHTML = `<div class="modal sheet" role="dialog" aria-modal="true"><div class="sheet-head"><h2></h2><button type="button" class="btn ghost sm" data-close aria-label="Close">✕</button></div><div class="sheet-body"></div></div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(back);
  const s = { back, close, body: back.querySelector('.sheet-body'), title: t => { back.querySelector('h2').textContent = t; } };
  s.title(title);
  return s;
}
const todayLocal = () => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); } };

// ---------------------------------------------------------------- quick log (+ Log button)
// car (skipped on a car page) -> job (schedule items + Other…) -> mileage/date/cost/note -> Save.
// Saves through POST /api/cars/:id/services (createService, the same path as MCP log_service).
async function openQuickLog() {
  const s = sheet('Log a service');
  const here = location.hash.match(/^#\/(?:car|catchup)\/([\w-]+)/);
  if (here) return qlJob(s, here[1]);
  s.body.innerHTML = '<p class="muted">Loading…</p>';
  const { cars } = await api('/api/cars');
  s.title('Log: which car?');
  const last = store.get('garage.car');
  s.body.innerHTML = `<div class="pick-list">${scanPick('')}${cars.map(c => `<button type="button" class="pick" data-car="${c.id}"><span class="grow"><strong>${h(c.nickname)}</strong><span class="small muted">${h(ymm(c))} · ${miles(c.mileage)}</span></span>${c.id === last ? '<span class="chip">last viewed</span>' : ''}<span class="pick-go" aria-hidden="true">›</span></button>`).join('')}</div>`;
  s.body.onclick = e => { if (e.target.closest('[data-ql-scan]')) return openScan('', s); const b = e.target.closest('[data-car]'); if (b) safe(qlJob)(s, b.dataset.car); };
}
const scanPick = carId => `<button type="button" class="pick scan" data-ql-scan="${h(carId)}"><span class="rc-ico" aria-hidden="true">${RECEIPT_ICON}</span><span class="grow"><strong>Scan a receipt</strong><span class="small muted">Photo or PDF; it fills everything in for you</span></span><span class="pick-go" aria-hidden="true">›</span></button>`;
async function qlJob(s, carId) {
  s.body.onclick = null;
  s.body.innerHTML = '<p class="muted">Loading…</p>';
  const d = await api(`/api/cars/${carId}`);
  if (!document.body.contains(s.back)) return;
  s.title(`Log: ${d.car.nickname}`);
  s.body.innerHTML = `<div class="pick-list" style="margin-bottom:12px">${scanPick(carId)}</div><p class="small muted" style="margin-top:0">Or pick what you did:</p><div class="pick-list">
    ${d.items.map(i => `<button type="button" class="pick" data-item="${i.id}"><span class="grow"><strong>${h(i.name)}</strong><span class="small muted">${h(i.label)}</span></span>${i.status === 'overdue' || i.status === 'soon' ? pill(i.status, i.label === 'Due now' ? 'Due now' : null) : ''}</button>`).join('')}
    <button type="button" class="pick other" data-item=""><span class="grow"><strong>Other…</strong><span class="small muted">Type what you did</span></span></button></div>`;
  s.body.onclick = e => { if (e.target.closest('[data-ql-scan]')) return openScan(carId, s); const b = e.target.closest('[data-item]'); if (b) qlForm(s, d, d.items.find(i => i.id === b.dataset.item) || null); };
}
function qlForm(s, d, item) {
  s.body.onclick = null;
  s.body.innerHTML = `<form class="ql-form" novalidate>
    ${item ? `<div class="ql-job"><div class="grow"><span class="small muted">Job</span><strong>${h(item.name)}</strong></div><button type="button" class="btn ghost sm" data-back>Change</button></div>`
      : field('What did you do?', 'title', '', 'text', 'required maxlength="160" placeholder="e.g. Replaced wiper blades"')}
    <div class="row ql-2">${field('Mileage', 'mileage', d.car.mileage ?? '', 'number', 'inputmode="numeric" min="0"')}${field('Date', 'date', todayLocal(), 'date', 'required')}</div>
    <div class="row ql-2">${field('Cost $ (optional)', 'cost', '', 'text', 'inputmode="decimal" placeholder="0.00"')}${field('Shop (blank = DIY)', 'shop', '', 'text', 'maxlength="120"')}</div>
    ${area('Note (optional)', 'details', '', 'rows="2" maxlength="8000"')}
    <button class="btn primary ql-save" type="submit">Save</button></form>`;
  const form = s.body.querySelector('form');
  if (!item) form.title.focus();
  form.querySelector('[data-back]')?.addEventListener('click', () => safe(qlJob)(s, d.car.id));
  form.onsubmit = safe(async e => {
    e.preventDefault();
    const f = formData(form);
    const title = item ? item.name : (f.title || '').trim();
    if (!title) { toast('Say what you did'); return; }
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      await api(`/api/cars/${d.car.id}/services`, { method: 'POST', body: { date: f.date, mileage: f.mileage, title, cost: f.cost, shop: f.shop, diy: !f.shop.trim(), details: f.details, item_ids: item ? [item.id] : [] } });
    } finally { btn.disabled = false; }
    s.close();
    toast(`Logged: ${title}`, true);
    render();
  });
}
document.addEventListener('click', e => { if (e.target.closest('#quick-log')) { e.preventDefault(); safe(openQuickLog)(); } });

// ---------------------------------------------------------------- receipts (scan -> AI draft -> confirm card -> service)
// Camera / photos / PDF -> POST /api/receipts (multipart) -> #/receipt/<id> confirm card -> POST .../confirm (createService).
const scanBtn = (carId = '', extra = '', label = 'Scan a receipt') => `<button type="button" class="btn scan-btn ${extra}" data-scan-receipt="${h(carId)}"><span aria-hidden="true">${RECEIPT_ICON}</span> ${h(label)}</button>`;
const CAMERA_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const RECEIPT_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>';
document.addEventListener('click', e => { const b = e.target.closest('[data-scan-receipt]'); if (b) { e.preventDefault(); openScan(b.dataset.scanReceipt || ''); } });

/** Photos from an iPhone can be 4-12 MB HEIC; send a ~2000 px JPEG instead (smaller, and the AI can read it). */
async function shrinkPhoto(file) {
  if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) return file;
  if (file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 2_500_000 && /^image\/(jpeg|png|webp)$/.test(file.type)) { bmp.close?.(); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], (file.name || 'receipt').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }   // can't decode here (e.g. HEIC outside Safari): send it as it is
}

function openScan(carId, s = null) {
  s ||= sheet('Scan a receipt');
  s.title('Scan a receipt');
  s.body.onclick = null;
  const pages = [];
  s.body.innerHTML = `<p class="small muted" style="margin-top:0">Snap each page, or pick photos or a PDF. The garage reads it and shows you a draft to check before anything is saved.</p>
    <div class="rc-pages" id="rc-pages" aria-live="polite"></div>
    <label class="btn primary rc-big" for="rc-cam"><span aria-hidden="true">${CAMERA_ICON}</span> <span id="rc-cam-label">Take a photo</span></label>
    <input id="rc-cam" type="file" accept="image/*,application/pdf" capture="environment" class="sr">
    <label class="btn rc-big" for="rc-pick">Choose photos or a PDF</label>
    <input id="rc-pick" type="file" accept="image/*,application/pdf" multiple class="sr">
    <button type="button" class="btn primary ql-save hidden" id="rc-go">Read receipt</button>
    <div class="rc-progress hidden" id="rc-progress" role="status"><span class="spinner" aria-hidden="true"></span><span id="rc-step">Uploading…</span></div>`;
  const $ = id => s.body.querySelector(`#${id}`);
  const draw = () => {
    $('rc-pages').innerHTML = pages.map((p, i) => `<div class="rc-page">${p.url ? `<img src="${p.url}" alt="Page ${i + 1}">` : `<span class="doc">${h(p.file.name)}</span>`}<span class="rc-n">${i + 1}</span><button type="button" class="rc-x" data-rm="${i}" aria-label="Remove page ${i + 1}">✕</button></div>`).join('');
    $('rc-cam-label').textContent = pages.length ? 'Add another page' : 'Take a photo';
    $('rc-go').classList.toggle('hidden', !pages.length);
    $('rc-go').textContent = pages.length > 1 ? `Read receipt (${pages.length} pages)` : 'Read receipt';
  };
  const add = files => { for (const f of files) if (pages.length < 8) pages.push({ file: f, url: /^image\/(jpeg|png|webp|gif)$/.test(f.type) ? URL.createObjectURL(f) : null }); draw(); };
  $('rc-cam').onchange = e => { add([...e.target.files]); e.target.value = ''; };
  $('rc-pick').onchange = e => { add([...e.target.files]); e.target.value = ''; };
  $('rc-pages').onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { const [p] = pages.splice(Number(b.dataset.rm), 1); if (p?.url) URL.revokeObjectURL(p.url); draw(); } };
  $('rc-go').onclick = safe(async () => {
    const go = $('rc-go'); go.disabled = true;
    s.body.querySelectorAll('label.btn').forEach(l => l.classList.add('hidden'));
    $('rc-progress').classList.remove('hidden');
    const step = t => { const el = $('rc-step'); if (el) el.textContent = t; };
    let timer;
    try {
      step('Getting the photos ready…');
      const fd = new FormData();
      if (carId) fd.append('car_id', carId);
      for (const p of pages) { const f = await shrinkPhoto(p.file); fd.append('file', f, f.name); }
      const t0 = Date.now();
      step(`Uploading ${pages.length} page${pages.length > 1 ? 's' : ''}…`);
      timer = setInterval(() => step(`Reading the receipt… ${Math.round((Date.now() - t0) / 1000)} s (usually 10–40 s)`), 1000);
      const r = await fetch('/api/receipts', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (r.status === 401) { location.href = `/auth/login?next=${encodeURIComponent('/' + location.hash)}`; return; }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      for (const p of pages) if (p.url) URL.revokeObjectURL(p.url);
      s.close();
      if (data.duplicate) toast(data.receipt.status === 'saved' ? 'You already saved this receipt' : 'This receipt is already waiting for you', true);
      location.hash = `#/receipt/${data.receipt.id}`;
    } catch (e) {
      go.disabled = false; $('rc-progress').classList.add('hidden'); s.body.querySelectorAll('label.btn').forEach(l => l.classList.remove('hidden'));
      throw e;
    } finally { clearInterval(timer); }
  });
}

function pendingReceiptsHtml(list, { car = false } = {}) {
  if (!list.length) return '';
  return `<div class="rc-pending"><div class="rc-head"><span aria-hidden="true">${RECEIPT_ICON}</span> ${list.length} receipt${list.length > 1 ? 's' : ''} to check</div>${list.slice(0, 5).map(r => {
    const d = r.draft, needs = r.questions.length + r.flags.length;
    return `<a class="rc-item" href="#/receipt/${r.id}"><span class="grow"><strong>${h(d.shop || d.title || 'Receipt')}${d.total != null ? ` · $${d.total.toFixed(2)}` : ''}</strong>
      <span class="small muted">${car ? '' : `${h(r.car?.nickname || 'which car?')} · `}${d.date ? fmtDate(d.date) : 'no date'}${r.parse_status === 'parsing' ? ' · reading…' : r.parse_status === 'failed' ? ' · couldn\'t read it' : needs ? ' · needs a look' : ' · ready to save'}</span></span><span class="pick-go" aria-hidden="true">›</span></a>`;
  }).join('')}</div>`;
}
async function fillPending(el, carId = null) {
  try { const { receipts } = await api(`/api/receipts${carId ? `?car=${carId}` : ''}`); if (document.body.contains(el)) el.innerHTML = pendingReceiptsHtml(receipts, { car: !!carId }); } catch { /* not critical */ }
}

const LINE_TYPE_LABEL = { part: 'Part', labor: 'Labor', service: 'Service', fee: 'Fee', discount: 'Discount' };
async function viewReceipt(seq, id) {
  dropViewer();
  const v = await api(`/api/receipts/${id}`);
  if (stale(seq)) return;
  document.title = 'Check receipt · ' + CONFIG.app_name;
  const d = v.draft;
  const lc = new Set(v.flags.map(f => f.field.replace(/\[\d+\].*$/, '')));
  const lcl = f => (lc.has(f) ? ' lc' : '');
  const back = v.car ? `#/car/${v.car.id}/history` : '#/';
  const done = v.status !== 'pending';
  let carId = v.car?.id || '';
  const carOf = () => v.cars.find(c => c.id === carId);
  const lineRow = (l, i) => `<div class="rc-line" data-i="${i}">
      <div class="field"><label for="rl-d${i}">Item</label><input type="text" id="rl-d${i}" name="description" value="${h(l.description)}" maxlength="200"></div>
      <div class="row rc-line-2"><div class="field"><label for="rl-b${i}">Brand</label><input type="text" id="rl-b${i}" name="brand" value="${h(l.brand || '')}" maxlength="60"></div>
        <div class="field"><label for="rl-p${i}">Part #</label><input type="text" id="rl-p${i}" name="part_number" value="${h(l.part_number || '')}" maxlength="40" autocapitalize="characters" spellcheck="false"></div></div>
      <div class="row rc-line-3"><div class="field"><label for="rl-q${i}">Qty</label><input type="text" id="rl-q${i}" name="qty" value="${l.qty ?? ''}" inputmode="decimal"></div>
        <div class="field"><label for="rl-a${i}">$</label><input type="text" id="rl-a${i}" name="amount" value="${l.amount != null ? l.amount.toFixed(2) : ''}" inputmode="decimal"></div>
        <div class="field"><label for="rl-t${i}">Type</label><select id="rl-t${i}" name="type">${Object.entries(LINE_TYPE_LABEL).map(([k, t]) => `<option value="${k}" ${k === l.type ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <button type="button" class="btn ghost sm rc-rm" data-rm-line="${i}" aria-label="Remove this line">✕</button></div></div>`;
  app.innerHTML = `<div class="car-head"><a class="btn ghost sm" href="${back}">‹ ${v.car ? h(v.car.nickname) : 'Garage'}</a><div><h1>${done ? 'Receipt' : 'Check receipt'}</h1>
      <div class="ymm small">From ${h(v.source === 'email' ? `email${v.from ? ` (${v.from})` : ''}` : v.source === 'mcp' ? 'Claude' : 'the app')}${v.created_by ? ` · ${h(v.created_by)}` : ''} · ${fmtTs(v.created_at)}</div></div></div>
    ${v.status === 'saved' ? `<div class="card rc-done">Saved to the ${h(v.car?.nickname || '')} history. <a href="${back}">Open the history ›</a></div>` : ''}
    ${v.status === 'discarded' ? '<div class="card rc-done">This receipt was discarded.</div>' : ''}
    ${v.parse_status === 'parsing' ? '<div class="card rc-warn"><span class="spinner" aria-hidden="true"></span> Still reading this receipt… <button class="btn sm" id="rc-reload">Refresh</button></div>' : ''}
    ${v.parse_status === 'failed' && !done ? `<div class="card rc-warn"><strong>Couldn't read all of it.</strong> <span class="small">${h(v.error || '')}</span><div style="margin-top:8px"><button class="btn sm" id="rc-retry">Try again</button> <span class="small muted">or fill it in below.</span></div></div>` : ''}
    ${!done && (v.questions.length || v.flags.length) ? `<div class="card rc-check"><h2>Check these</h2><ul>${v.questions.map(q => `<li>${h(q)}</li>`).join('')}${v.flags.map(f => `<li class="${f.level}">${h(f.msg)}</li>`).join('')}</ul></div>` : ''}
    <form class="card rc-form" id="rc-form" novalidate>
      <div class="field${lcl('car')}"><label for="rc-car">Car</label><select id="rc-car" name="car_id" ${done ? 'disabled' : ''}>${carId ? '' : '<option value="">Pick the car…</option>'}${v.cars.map(c => `<option value="${c.id}" ${c.id === carId ? 'selected' : ''}>${h(c.nickname)} (${h(c.label)})</option>`).join('')}</select></div>
      <div class="row ql-2"><div class="field${lcl('date')}"><label for="rc-date">Date</label><input id="rc-date" name="date" type="date" value="${h(d.date || '')}" max="${todayLocal()}"></div>
        <div class="field${lcl('mileage')}"><label for="rc-miles">Odometer</label><input id="rc-miles" name="mileage" type="number" inputmode="numeric" min="0" value="${d.mileage ?? ''}" placeholder="${carOf()?.mileage ? `last ${carOf().mileage}` : 'miles'}"></div></div>
      <div class="field${lcl('shop')}"><label for="rc-shop">Shop / store</label><input type="text" id="rc-shop" name="shop" value="${h(d.shop || '')}" maxlength="120"></div>
      <div class="field"><label for="rc-title">What was done</label><input type="text" id="rc-title" name="title" value="${h(d.title || '')}" maxlength="160"></div>
      <div class="row ql-2"><div class="field${lcl('total')}"><label for="rc-total">Total $</label><input type="text" id="rc-total" name="total" inputmode="decimal" value="${d.total != null ? d.total.toFixed(2) : ''}"></div>
        <div class="field${lcl('tax')}"><label for="rc-tax">Tax $</label><input type="text" id="rc-tax" name="tax" inputmode="decimal" value="${d.tax != null ? d.tax.toFixed(2) : ''}"></div></div>
      <div class="field"><label for="rc-kind">Who did the work?</label><select id="rc-kind" name="kind"><option value="service" ${d.kind !== 'parts' ? 'selected' : ''}>A shop did it</option><option value="parts" ${d.kind === 'parts' ? 'selected' : ''}>I bought parts (DIY)</option></select></div>
      <div class="rc-sec"><h2>Jobs to mark done</h2><div id="rc-items"></div></div>
      <div class="rc-sec" id="rc-todos-wrap"><div id="rc-todos"></div></div>
      <details class="rc-sec rc-lines"${lc.has('line_items') ? ' open' : ''}><summary><h2>Line items <span class="muted small">(${d.line_items.length})</span></h2></summary>
        <div id="rc-lines">${d.line_items.map(lineRow).join('')}</div>
        <button type="button" class="btn sm" id="rc-add-line">＋ Add a line</button>
        ${d.not_performed.length ? `<p class="small muted">Recommended, not done: ${h(d.not_performed.join('; '))}</p>` : ''}</details>
      ${v.files?.length ? `<div class="rc-sec"><h2>Receipt</h2><div class="thumbs">${v.files.map(f => `<a href="/api/files/${f.id}" target="_blank" rel="noopener">${/^image\/(jpeg|png|webp|gif)$/.test(f.content_type) ? `<img src="/api/files/${f.id}" alt="${h(f.filename)}" loading="lazy">` : `<span class="doc">${h(f.filename)}</span>`}</a>`).join('')}</div></div>` : ''}
    </form>
    ${done ? '' : `<div class="rc-bar"><button type="button" class="btn ghost danger" id="rc-discard">Discard</button><button type="button" class="btn primary" id="rc-save">Save to history</button></div>`}`;
  const form = document.getElementById('rc-form');
  if (done) form.querySelectorAll('input,select,button').forEach(x => { x.disabled = true; });
  const itemsBox = document.getElementById('rc-items'), todosBox = document.getElementById('rc-todos');
  const drawJobs = (keep = null) => {
    const c = carOf();
    if (!c) { itemsBox.innerHTML = '<p class="small muted">Pick the car first.</p>'; todosBox.innerHTML = ''; return; }
    const sel = new Set(keep || (c.id === v.car?.id ? v.matched.map(m => m.id) : c.matched));
    const on = c.items.filter(i => sel.has(i.id)), off = c.items.filter(i => !sel.has(i.id));
    const box = i => `<label class="check rc-job"><input type="checkbox" name="item_ids" data-multi="1" value="${i.id}" ${sel.has(i.id) ? 'checked' : ''} ${done ? 'disabled' : ''}> ${h(i.name)}</label>`;
    itemsBox.innerHTML = `${on.length ? on.map(box).join('') : '<p class="small muted">Nothing on the schedule matched. Tick any that apply.</p>'}
      ${off.length ? `<details><summary class="small muted">Other jobs on the ${h(c.nickname)}'s schedule (${off.length})</summary>${off.map(box).join('')}</details>` : ''}`;
    const tc = c.id === v.car?.id ? v.todo_candidates : c.todo_candidates;
    todosBox.innerHTML = tc.length && !done ? `<h2>Did this take care of…</h2>${tc.map(t => `<label class="check"><input type="checkbox" name="close_todo" data-multi="1" value="${t.id}"> ${h(t.title)} <span class="small muted">(closes the to-do)</span></label>`).join('')}` : '';
    const miles = document.getElementById('rc-miles'); if (!miles.value) miles.placeholder = c.mileage ? `last ${c.mileage}` : 'miles';
  };
  drawJobs();
  document.getElementById('rc-car').onchange = e => { carId = e.target.value; drawJobs(); };
  document.getElementById('rc-reload')?.addEventListener('click', () => render());
  if (v.parse_status === 'parsing') setTimeout(() => { if (location.hash === `#/receipt/${id}`) render(); }, 5000);
  document.getElementById('rc-retry')?.addEventListener('click', safe(async e => {
    e.target.disabled = true; e.target.textContent = 'Reading…';
    try { await api(`/api/receipts/${id}/reparse`, { method: 'POST', body: {} }); } finally { render(); }
  }));
  if (done) return;
  const lines = document.getElementById('rc-lines');
  document.getElementById('rc-add-line').onclick = () => { const i = lines.children.length + Date.now() % 1000; lines.insertAdjacentHTML('beforeend', lineRow({ description: '', type: 'part' }, i)); lines.lastElementChild.querySelector('input').focus(); };
  lines.onclick = e => { const b = e.target.closest('[data-rm-line]'); if (b) b.closest('.rc-line').remove(); };
  document.getElementById('rc-discard').onclick = () => modal('Discard this receipt?', '<p>Nothing gets logged, and the uploaded photos are deleted.</p>', {
    submit: 'Discard', danger: true, onSubmit: async () => { await api(`/api/receipts/${id}/discard`, { method: 'POST', body: {} }); toast('Discarded', true); location.hash = back; },
  });
  document.getElementById('rc-save').onclick = safe(async () => {
    const f = formData(form);
    if (!f.car_id) { toast('Pick the car first'); document.getElementById('rc-car').focus(); return; }
    if (!f.date) { toast('Add the date'); document.getElementById('rc-date').focus(); return; }
    const lineItems = [...lines.querySelectorAll('.rc-line')].map(r => Object.fromEntries([...r.querySelectorAll('input,select')].map(x => [x.name, x.value.trim()]))).filter(l => l.description || l.amount);
    const edits = { car_id: f.car_id, date: f.date, mileage: f.mileage, shop: f.shop, title: f.title, total: f.total, tax: f.tax, kind: f.kind, line_items: lineItems, item_ids: f.item_ids || [] };
    const btn = document.getElementById('rc-save'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await api(`/api/receipts/${id}/confirm`, { method: 'POST', body: { edits, close_todo_ids: f.close_todo || [] } });
      toast(`Saved: ${r.title}${r.marked_done?.length ? ` · ${r.marked_done.length} job${r.marked_done.length > 1 ? 's' : ''} marked done` : ''}`, true);
      location.hash = `#/car/${f.car_id}/history`;
    } finally { btn.disabled = false; btn.textContent = 'Save to history'; }
  });
}

// poll pending AI notes while the page that shows them is open
let pollTimer = null, pollCount = 0;
function pollAi(ids) {
  clearTimeout(pollTimer);
  if (!ids.length || pollCount > 40) return;
  const here = location.hash;
  pollTimer = setTimeout(async () => {
    if (location.hash !== here || document.querySelector('.modal-back')) return pollAi(ids);
    pollCount++;
    const states = await Promise.all(ids.map(id => api(`/api/todos/${id}`).catch(() => null)));
    if (states.some(s => s && s.ai_status !== 'pending')) { pollCount = 0; render(); } else pollAi(ids);
  }, 5000);
}

// ---------------------------------------------------------------- tiny markdown (mechanic answers)
function md(src) {
  const blocks = String(src || '').replace(/\r/g, '').split(/```/);
  let out = '';
  blocks.forEach((blk, i) => {
    if (i % 2) { out += `<pre class="extract">${h(blk.replace(/^\w*\n/, ''))}</pre>`; return; }
    const lines = blk.split('\n');
    let list = null, para = [];
    const inline = s => h(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const flushP = () => { if (para.length) { out += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
    const flushL = () => { if (list) { out += `<${list.t}>${list.items.map(x => `<li>${inline(x)}</li>`).join('')}</${list.t}>`; list = null; } };
    for (const line of lines) {
      const ul = line.match(/^\s*[-*•]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/), hd = line.match(/^#{1,4}\s+(.*)/);
      if (hd) { flushP(); flushL(); out += `<h4>${inline(hd[1])}</h4>`; }
      else if (ul || ol) { flushP(); const t = ul ? 'ul' : 'ol'; if (list && list.t !== t) flushL(); (list ||= { t, items: [] }).items.push((ul || ol)[1]); }
      else if (!line.trim()) { flushP(); flushL(); }
      else if (/^\s*\|/.test(line)) { flushL(); para.push(line); }
      else { flushL(); para.push(line); }
    }
    flushP(); flushL();
  });
  return out;
}

// ---------------------------------------------------------------- shared bits
const STATUS_LABEL = { overdue: 'Overdue', soon: 'Due soon', ok: 'OK', unknown: 'Unknown' };
const pill = (status, text) => `<span class="pill ${status}">${h(text || STATUS_LABEL[status] || status)}</span>`;
function meter(health) {
  const n = Math.round(health / 10), c = health >= 70 ? 'var(--green)' : health >= 40 ? 'var(--amber)' : 'var(--red)';
  return `<div style="display:flex;align-items:center"><div class="meter" style="--c:${c};flex:1" role="meter" aria-valuenow="${health}" aria-valuemin="0" aria-valuemax="100" aria-label="Health">${Array.from({ length: 10 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div><span class="meter-num" style="color:${c}">${health}</span></div>`;
}
function nextDueText(s) {
  if (!s.next_due) return s.unknown_count ? 'Set last-done dates' : 'Nothing scheduled';
  return `${s.next_due.name} · ${s.next_due.label}`;
}

// 3D viewer lifecycle: at most one live WebGL context at a time (iOS limits contexts)
let viewer = null, viewerKey = null;
function dropViewer() { viewer?.dispose(); viewer = null; viewerKey = null; }
async function mountCar(el, car, { key, dir = 0, garage = true, onSwipe, focusEl = null } = {}) {
  if (!HAS_GL) { el.innerHTML = carSvg(car.body_type, car.color, { label: car.nickname }); el.classList.add('svg-fallback'); return null; }
  if (viewer && viewerKey === key && viewer.el === el) { viewer.show(car, dir); return viewer; }
  dropViewer();
  el.innerHTML = '';
  const v = new CarViewer(el, { garage });
  viewer = v; viewerKey = key;
  try { await v.init(); }
  catch (e) {
    console.warn('3D unavailable, falling back to SVG', e);
    if (viewer === v) dropViewer();
    el.innerHTML = carSvg(car.body_type, car.color, { label: car.nickname }); return null;
  }
  if (viewer !== v) { v.dispose(); return null; } // navigated away while loading
  v.onSwipe = onSwipe;
  if (focusEl) { v.focusEl = focusEl; window.addEventListener('resize', () => v.resize()); }
  v.show(car, 0);
  return v;
}

// ---------------------------------------------------------------- router
const routes = [
  [/^#?\/?$/, viewGarage],
  [/^#\/car\/([\w-]+)(?:\/(\w+))?$/, viewCar],
  [/^#\/due$/, viewDue],
  [/^#\/inbox$/, viewInbox],
  [/^#\/settings$/, viewSettings],
  [/^#\/catchup\/([\w-]+)$/, viewCatchup],
  [/^#\/new-car$/, viewNewCar],
  [/^#\/receipt\/([\w-]+)$/, viewReceipt],
  [/^#\/diagnose\/([\w-]+)(?:\/([\w-]+))?$/, viewDiagnoseStart],
  [/^#\/diag\/([\w-]+)$/, viewDiag],
];
let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const hash = location.hash || '#/';
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', hash.startsWith(a.getAttribute('href')) && (a.getAttribute('href') !== '#/' || hash === '#/' || hash === '')));
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try { await fn(seq, ...m.slice(1)); }
      catch (e) { if (seq === renderSeq) app.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${h(e.message)}</p><p><a class="btn" href="#/">Back to the garage</a></p></div>`; }
      return;
    }
  }
  location.hash = '#/';
}
const stale = seq => seq !== renderSeq;
window.addEventListener('hashchange', () => { if (!/^#\/car\/[\w-]+/.test(location.hash) && !(location.hash === '#/' || location.hash === '')) dropViewer(); render(); });

async function refreshInboxBadge() {
  try {
    const { scans } = await api('/api/scans?unmatched=1');
    const b = document.getElementById('inbox-badge');
    b.textContent = scans.length; b.classList.toggle('hidden', !scans.length);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- garage select
async function viewGarage(seq) {
  const { cars, today } = await api('/api/cars');
  if (stale(seq)) return;
  TODAY = today;
  document.title = CONFIG.app_name;
  if (!cars.length) {
    dropViewer();
    app.innerHTML = `<section class="bay"><div class="ceiling"><i></i><i></i></div><div class="empty-bay"><h1>The bay is empty</h1><p class="muted">Add your first car.</p><a class="btn primary" href="#/new-car">Add a car</a></div></section>`;
    return;
  }
  let idx = Math.max(0, cars.findIndex(c => c.id === store.get('garage.car')));
  app.innerHTML = `<div id="rc-top" class="rc-top"></div><section class="bay${HAS_GL ? ' gl' : ''}">
    ${HAS_GL ? '<div class="car-holder gl" id="holder"></div>' : '<div class="ceiling"><i></i><i></i><i></i></div>'}
    <div class="bay-head"><h1>SELECT YOUR RIDE</h1><span class="count" id="bay-count"></span></div>
    <div class="select-layout">
      <div>
        <div class="stage">
          <button class="arrow l" id="prev" aria-label="Previous car">‹</button>
          <div class="stall" id="stall"><div class="stall-number" id="bay-num"></div>${HAS_GL ? '' : '<div class="car-holder" id="holder"></div>'}</div>
          <button class="arrow r" id="next" aria-label="Next car">›</button>
        </div>
        <div class="dots" id="dots">${cars.map((c, i) => `<button data-i="${i}" aria-label="${h(c.nickname)}"></button>`).join('')}</div>
        <p class="keys-hint">← → to switch · drag to spin · Enter to select</p>
      </div>
      <div><aside class="stats" id="stats" aria-live="polite"></aside><div id="new-research"></div></div>
    </div></section>`;
  const holder = document.getElementById('holder');
  fillPending(document.getElementById('rc-top'));
  api('/api/research/recent').then(({ reports }) => {
    const box = document.getElementById('new-research'); if (!box || !reports.length) return;
    const unseen = reports.filter(r => r.unseen).length;
    box.innerHTML = `<div class="new-research"><div class="nr-head">Research reports ${unseen ? `<span class="badge">${unseen} new</span>` : ''}</div>${reports.slice(0, 4).map(r => `<a href="#/car/${r.car_id}/todo" class="nr-item${r.unseen ? ' unseen' : ''}"><strong>${h(r.car)}</strong> · ${h(r.title)}<span class="small muted">${h(r.summary)}</span></a>`).join('')}</div>`;
  }).catch(() => {});
  const draw = async (dir = 0) => {
    const c = cars[idx];
    store.set('garage.car', c.id);
    document.getElementById('bay-num').textContent = `BAY ${String(idx + 1).padStart(2, '0')}`;
    document.getElementById('bay-count').textContent = `${idx + 1} / ${cars.length}`;
    document.querySelectorAll('#dots button').forEach((b, i) => b.classList.toggle('on', i === idx));
    const s = c.summary;
    document.getElementById('stats').innerHTML = `
      <div class="tag">${h((BODY_LABELS[c.body_type] || c.body_type).toUpperCase())}</div>
      <h2>${h(c.nickname)}</h2>
      <div class="ymm">${h(ymm(c))}${c.engine ? ` · ${h(c.engine.replace(/\s*\(.*\)/, ''))}` : ''}</div>
      <div class="stat"><span class="k">Mileage</span><span class="v">${miles(c.mileage)}</span></div>
      <div class="stat"><span class="k">Health</span>${meter(s.health)}</div>
      <div class="stat"><span class="k">Next service</span><span class="v small">${h(nextDueText(s))}</span></div>
      <div class="stat"><span class="k">Overdue</span><span class="v" style="color:${s.overdue_count ? 'var(--red)' : 'var(--green)'}">${s.overdue_count}${s.soon_count ? ` <span class="small muted" style="font-family:var(--font)">+ ${s.soon_count} due soon</span>` : ''}</span></div>
      <div class="stat"><span class="k">Open issues</span><span class="v" style="color:${s.open_issues ? 'var(--amber)' : 'var(--green)'}">${s.open_issues}</span></div>
      ${s.catchup_pending ? `<a class="catchup-link small" href="#/catchup/${c.id}">${s.catchup_pending} item${s.catchup_pending > 1 ? 's have' : ' has'} no history: catch up ›</a>` : ''}
      <button class="btn primary select-btn" id="select">SELECT</button>
      ${symptomBtn(c.id, 'in-card')}
      ${scanBtn('', 'in-card')}`;
    document.getElementById('select').onclick = () => { location.hash = `#/car/${c.id}/overview`; };
    if (!HAS_GL) {
      holder.classList.remove('enter-r', 'enter-l'); void holder.offsetWidth;
      if (dir) holder.classList.add(dir > 0 ? 'enter-r' : 'enter-l');
    }
    await mountCar(holder, c, { key: 'garage', dir, onSwipe: d => go(d), focusEl: document.getElementById('stall') });
  };
  const go = d => { idx = (idx + d + cars.length) % cars.length; draw(d); };
  document.getElementById('prev').onclick = () => go(-1);
  document.getElementById('next').onclick = () => go(1);
  document.getElementById('dots').onclick = e => { const b = e.target.closest('button'); if (b) { const n = Number(b.dataset.i); const d = n > idx ? 1 : -1; if (n !== idx) { idx = n; draw(d); } } };
  // swipe on the stats card (the canvas handles its own flick-vs-orbit)
  let sx = null;
  const card = document.getElementById('stats');
  card.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  card.addEventListener('touchend', e => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); });
  if (!HAS_GL) {
    holder.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    holder.addEventListener('touchend', e => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); });
  }
  keyHandler = e => {
    if (e.target.closest('input,textarea,select')) return;
    if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); else if (e.key === 'Enter') location.hash = `#/car/${cars[idx].id}/overview`;
  };
  await draw(0);
  window.dispatchEvent(new Event('garage:ready'));
}
let keyHandler = null;
document.addEventListener('keydown', e => { if ((location.hash === '#/' || location.hash === '') && keyHandler && !document.querySelector('.modal-back')) keyHandler(e); });

// ---------------------------------------------------------------- car page
const TABS = [['overview', 'Overview'], ['maintenance', 'Maintenance'], ['history', 'History'], ['todo', 'To-do'], ['parts', 'Parts'], ['alternates', 'Alternates'], ['shopping', 'Shopping list'], ['guides', 'Guides'], ['research', 'Research'], ['mechanic', 'Ask the mechanic'], ['scans', 'Scans']];
async function viewCar(seq, id, tab = 'overview') {
  if (!TABS.some(t => t[0] === tab) || (tab === 'mechanic' && CONFIG.ai === false)) tab = 'overview';
  const data = await api(`/api/cars/${id}`);
  if (stale(seq)) return;
  TODAY = data.today;
  const c = data.car;
  document.title = `${c.nickname} · ${CONFIG.app_name}`;
  if (tab !== 'overview') dropViewer();
  app.innerHTML = `
    <div class="car-head">
      <a class="btn ghost sm" href="#/" aria-label="Back to the garage">‹ Garage</a>
      <div><h1>${h(c.nickname)}</h1><div class="ymm">${h(ymm(c))} · ${miles(c.mileage)}</div></div>
      <div class="actions">${scanBtn(c.id, 'sm', 'Scan receipt')}<button class="btn sm" id="edit-car">Edit car</button></div>
    </div>
    ${catchupBanner(c.id, data.summary.catchup_pending)}
    <div id="rc-car"></div>
    <nav class="tabs" aria-label="Car sections">${TABS.filter(([k]) => k !== 'mechanic' || CONFIG.ai !== false).map(([k, l]) => `<a href="#/car/${c.id}/${k}" class="${k === tab ? 'on' : ''}">${l}${k === 'todo' && data.summary.open_issues ? ` <span class="badge">${data.summary.open_issues}</span>` : ''}${k === 'maintenance' && data.summary.overdue_count ? ` <span class="badge">${data.summary.overdue_count}</span>` : ''}</a>`).join('')}</nav>
    <div id="tab"></div>`;
  document.getElementById('edit-car').onclick = () => editCar(c);
  fillPending(document.getElementById('rc-car'), c.id);
  const el = document.getElementById('tab');
  const reload = () => render();
  await ({ overview: tabOverview, maintenance: tabMaintenance, history: tabHistory, todo: tabTodo, parts: tabParts, alternates: tabAlternates, shopping: tabShopping, guides: tabGuides, research: tabResearch, mechanic: tabMechanic, scans: tabScans })[tab](el, data, reload);
}

// ---------------------------------------------------------------- catch-up (approximate last-done dates)
const fmtMonth = d => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '');
const catchupBanner = (carId, n) => n ? `<a class="catchup-banner" href="#/catchup/${carId}"><span class="grow"><strong>${n} item${n > 1 ? 's have' : ' has'} no history</strong> · catch up (2 min)</span><span aria-hidden="true">›</span></a>` : '';
function lastDoneText(i) {
  if (i.last_done_estimated) return `<span title="Estimate from the catch-up screen">~${fmtMonth(i.last_done_date)}${i.last_done_miles != null ? ` @ ~${miles(i.last_done_miles)}` : ''}</span> <span class="chip est-chip">estimate</span>`;
  if (i.last_done_date || i.last_done_miles != null) return `${fmtDate(i.last_done_date)}${i.last_done_miles != null ? ` @ ${miles(i.last_done_miles)}` : ''}`;
  if (i.catchup_answer === 'unknown') return '<em>unknown (don\'t remember)</em>';
  if (i.catchup_answer === 'never') return '<em>never done</em>';
  return '<em>unknown, set last done</em>';
}
async function viewCatchup(seq, id) {
  dropViewer();
  const d = await api(`/api/cars/${id}/catchup`);
  if (stale(seq)) return;
  const c = d.car;
  document.title = `Catch up · ${c.nickname} · ${CONFIG.app_name}`;
  const picked = {};
  for (const i of d.items) if (i.answer) picked[i.id] = i.answer;
  const every = i => [i.interval_miles ? miles(i.interval_miles) : null, i.interval_months ? `${i.interval_months} mo` : null].filter(Boolean).join(' / ');
  const row = i => `<div class="cu-row${i.pending ? '' : ' done'}" data-id="${i.id}">
      <div class="cu-name"><strong>${h(i.name)}</strong> <span class="small muted">every ${every(i)}</span>
        ${i.estimated ? `<div class="small muted">Now: ~${fmtMonth(i.last_done_date)}${i.last_done_miles != null ? ` @ ~${miles(i.last_done_miles)}` : ''}</div>` : ''}${i.due_now && !i.answer ? '<div class="small" style="color:var(--amber)">Marked due now</div>' : ''}</div>
      <div class="cu-opts" role="group" aria-label="${h(i.name)}: last done">${d.answers.map(a => `<button type="button" data-a="${a.key}" aria-pressed="${picked[i.id] === a.key}">${h(a.label)}</button>`).join('')}</div></div>`;
  const pending = d.items.filter(i => i.pending), rest = d.items.filter(i => !i.pending);
  app.innerHTML = `<div class="car-head"><a class="btn ghost sm" href="#/car/${c.id}/maintenance">‹ ${h(c.nickname)}</a><div><h1>Catch up</h1><div class="ymm">${h(ymm(c))}</div></div></div>
    ${!d.items.length ? '<div class="card big-check">Every item has a real service logged. Nothing to catch up.</div>' : `
    <section class="card cu-step" id="cu-1"><h2><span class="cu-num">1</span> Odometer now</h2>
      <p class="small muted" style="margin-top:0">${c.mileage_updated_at ? `Last updated ${fmtDate(c.mileage_updated_at)}.` : ''} Fix it if it's off.</p>
      <div class="cu-miles"><input id="cu-miles" type="number" inputmode="numeric" min="0" value="${c.mileage ?? ''}" aria-label="Current mileage"><span>mi</span></div>
      <button type="button" class="btn primary cu-go" id="cu-ok">That's right</button></section>
    <section id="cu-2" class="cu-items hidden"><h2><span class="cu-num">2</span> Roughly when was each last done?</h2>
      <p class="small muted">Tap your best guess. These are saved as estimates (shown with ~), not as service history. ${d.miles_per_month ? `Miles are estimated at about ${d.miles_per_month.toLocaleString('en-US')} mi/month.` : "This car's miles per month isn't known yet, so only dates are saved (the monthly mileage check builds that up)."} "Don't remember" stops it asking; "Never" marks it due now.</p>
      ${pending.map(row).join('')}
      ${rest.length ? `<details class="cu-more"${pending.length ? '' : ' open'}><summary class="small muted">${rest.length} already answered (change them here)</summary>${rest.map(row).join('')}</details>` : ''}
    </section>
    <div class="cu-bar hidden" id="cu-bar"><span id="cu-count" class="small"></span><button type="button" class="btn primary" id="cu-save">Save</button></div>`}`;
  if (!d.items.length) return;
  const bar = document.getElementById('cu-bar'), count = document.getElementById('cu-count');
  const changed = () => Object.keys(picked).filter(k => d.items.find(i => i.id === k)?.answer !== picked[k]);
  const upd = () => { const n = changed().length; count.textContent = `${Object.keys(picked).length} of ${d.items.length} answered${n ? ` · ${n} to save` : ''}`; document.getElementById('cu-save').disabled = !n && Number(document.getElementById('cu-miles').value) === c.mileage; };
  document.getElementById('cu-ok').onclick = () => {
    document.getElementById('cu-2').classList.remove('hidden'); bar.classList.remove('hidden');
    document.getElementById('cu-ok').classList.add('hidden'); upd();
    document.getElementById('cu-2').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  document.getElementById('cu-miles').oninput = upd;
  document.getElementById('cu-2').onclick = e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const r = b.closest('[data-id]');
    r.querySelectorAll('[data-a]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    picked[r.dataset.id] = b.dataset.a; r.classList.add('done'); upd();
  };
  document.getElementById('cu-save').onclick = safe(async () => {
    const btn = document.getElementById('cu-save'); btn.disabled = true;
    try {
      const answers = Object.fromEntries(changed().map(k => [k, picked[k]]));
      const r = await api(`/api/cars/${c.id}/catchup`, { method: 'POST', body: { mileage: document.getElementById('cu-miles').value, answers } });
      toast(`Saved ${r.updated} answer${r.updated === 1 ? '' : 's'}`, true);
      location.hash = `#/car/${c.id}/maintenance`;
    } finally { btn.disabled = false; }
  });
}

function dueRow(i, carId) {
  return `<li><div class="grow"><a href="#/car/${carId}/maintenance" style="color:inherit;text-decoration:none"><strong>${h(i.name)}</strong></a><div class="small muted">${h(i.label)}</div></div>${pill(i.status, i.status === 'overdue' && i.label === 'Due now' ? 'Due now' : null)}</li>`;
}

async function tabOverview(el, d, reload) {
  const c = d.car, s = d.summary;
  const overdue = d.items.filter(i => i.status === 'overdue'), soon = d.items.filter(i => i.status === 'soon');
  const nextUp = d.items.filter(i => i.status === 'ok').slice(0, 3);
  const unknown = d.items.filter(i => i.status === 'unknown');
  const open = d.todos.filter(t => t.status === 'open');
  el.innerHTML = `${activeDiagHtml(d.diagnoses)}${fluidsCard(d.fluids, c.id)}<div class="symptom-bar dg-sbar">${symptomBtn(c.id)}${diagBtn(c.id, '', 'Diagnose a problem', 'dg-btn')}</div><div class="grid2">
    <div>
      <div class="mini-stage" id="stage3d" style="height:min(56vw,360px)"></div>
      <p class="small muted" style="margin:6px 2px 0">${HAS_GL ? 'Drag to spin.' : ''} Model of a ${h(ymm(c))}; your own photos are below.</p>
      <div class="card" style="margin-top:12px">
        <div class="section-title" style="margin-top:0"><h2>My car</h2><label class="btn sm" for="photo-in">Add photo</label><input id="photo-in" type="file" accept="image/*" multiple class="sr"></div>
        <div class="thumbs">${d.photos.length ? d.photos.map(p => `<a href="/api/files/${p.id}" target="_blank" rel="noopener"><img src="/api/files/${p.id}" alt="${h(p.filename)}" loading="lazy"></a>`).join('') : '<span class="muted small">No photos yet. Add a few of the real car.</span>'}</div>
      </div>
    </div>
    <div>
      <div class="card">
        <div class="row" style="align-items:center">
          <div style="flex:1"><div class="small muted">Odometer${c.mileage_updated_at ? ` · updated ${fmtDate(c.mileage_updated_at)}` : ''}</div><div class="big-num">${miles(c.mileage)}</div></div>
          <form id="miles-form" class="row" style="flex:1;min-width:200px;align-items:flex-end">
            <div class="field" style="margin:0;flex:1"><label for="new-miles">Update mileage</label><input id="new-miles" name="mileage" type="number" inputmode="numeric" min="0" placeholder="${c.mileage ?? ''}" required></div>
            <button class="btn primary" type="submit">Save</button>
          </form>
        </div>
        <div style="margin-top:12px"><div class="small muted">Health</div>${meter(s.health)}</div>
      </div>
      <div class="card"><h2>Overdue / due now</h2>${overdue.length ? `<ul class="list">${overdue.map(i => dueRow(i, c.id)).join('')}</ul>` : '<p class="muted">Nothing overdue.</p>'}</div>
      ${soon.length ? `<div class="card"><h2>Due soon</h2><ul class="list">${soon.map(i => dueRow(i, c.id)).join('')}</ul></div>` : ''}
      <div class="card"><h2>Next up</h2>${nextUp.length ? `<ul class="list">${nextUp.map(i => dueRow(i, c.id)).join('')}</ul>` : '<p class="muted">Nothing tracked yet.</p>'}
        ${unknown.length ? `<p class="small muted">${unknown.length} item${unknown.length > 1 ? 's have' : ' has'} no last-done date yet. <a href="#/catchup/${c.id}">Catch up (2 min)</a> so they can be tracked.</p>` : ''}</div>
      <div class="card"><h2>Open issues</h2>${open.length ? `<ul class="list">${open.map(t => `<li><div class="grow"><a href="#/car/${c.id}/todo" style="color:inherit"><strong>${h(t.title)}</strong></a>${t.type === 'symptom' ? ' <span class="chip symptom-chip">symptom</span>' : ''}</div>${pill(t.priority, t.priority)}</li>`).join('')}</ul>` : '<p class="muted">No open issues.</p>'}</div>
      ${c.notes ? `<div class="card"><h2>Notes</h2><p style="white-space:pre-wrap;margin:0">${h(c.notes)}</p></div>` : ''}
    </div></div>`;
  mountCar(document.getElementById('stage3d'), c, { key: `car:${c.id}`, garage: false });
  // #/car/<id>/mileage (link in the monthly mileage notification): overview with the odometer box ready to type in
  if (/\/mileage$/.test(location.hash)) { const inp = document.getElementById('new-miles'); inp.scrollIntoView({ block: 'center' }); inp.focus(); }
  document.getElementById('miles-form').onsubmit = safe(async e => {
    e.preventDefault();
    await api(`/api/cars/${c.id}/mileage`, { method: 'POST', body: { mileage: e.target.mileage.value } });
    toast('Mileage updated', true); reload();
  });
  document.getElementById('photo-in').onchange = safe(async e => {
    const files = [...e.target.files];
    for (const f of files) await api(`/api/cars/${c.id}/photos`, { method: 'POST', raw: f });
    toast(`${files.length} photo${files.length > 1 ? 's' : ''} added`, true); reload();
  });
}

function itemForm(i = {}) {
  return `${field('Name', 'name', i.name, 'text', 'required maxlength="120"')}
  <div class="row">${field('Every (miles)', 'interval_miles', i.interval_miles ?? '', 'number', 'min="1" inputmode="numeric"')}${field('Every (months)', 'interval_months', i.interval_months ?? '', 'number', 'min="1" inputmode="numeric"')}</div>
  <div class="row">${field('Last done (date)', 'last_done_date', i.last_done_date ?? '', 'date')}${field('Last done (miles)', 'last_done_miles', i.last_done_miles ?? '', 'number', 'min="0" inputmode="numeric"')}</div>
  <label class="check"><input type="checkbox" name="due_now" ${i.due_now ? 'checked' : ''}> Due now (regardless of interval)</label>
  ${area('Notes', 'notes', i.notes ?? '')}`;
}

async function tabMaintenance(el, d, reload) {
  const c = d.car;
  el.innerHTML = `<div class="section-title" style="margin-top:0"><h2>Schedule</h2><a class="btn sm" href="#/catchup/${c.id}" style="margin-left:auto">Catch up</a><button class="btn sm primary" id="add-item" style="margin-left:0">Add item</button></div>
    <p class="small muted">Dates and miles marked <strong>~</strong> are estimates from the catch-up screen; logging a real service replaces them.</p>
    <p class="small muted">Researched schedule: items marked <span class="chip">manual</span> come from the owner's manual, <span class="chip">typical</span> are common practice. Full details on the Research tab.</p>
    ${d.items.map(i => `<details class="item" data-id="${i.id}">
      <summary>${pill(i.status, i.label === 'Due now' ? 'Due now' : null)}
        <div><div class="name">${h(i.name)} ${i.source === 'manual' ? '<span class="chip">manual</span>' : i.source === 'typical' ? '<span class="chip">typical</span>' : ''}${i.severe ? '<span class="chip" style="border-color:#ffb02066">severe service</span>' : ''}</div><div class="meta">Every ${[i.interval_miles ? miles(i.interval_miles) : null, i.interval_months ? `${i.interval_months} mo` : null].filter(Boolean).join(' / ')}
          · Last: ${lastDoneText(i)}</div></div>
        <div class="next">${i.next_due_miles != null ? `Next ${i.last_done_estimated ? '~' : ''}${miles(i.next_due_miles)}` : ''}${i.next_due_miles != null && i.next_due_date ? '<br>' : ''}${i.next_due_date ? `by ${i.last_done_estimated ? '~' : ''}${fmtDate(i.next_due_date)}` : ''}${i.status === 'unknown' ? '<span class="muted">—</span>' : ''}</div>
      </summary>
      <div class="body">
        <p class="small">${h(i.label)}</p>
        ${i.notes ? `<p class="small muted" style="white-space:pre-wrap">${h(i.notes)}</p>` : ''}
        ${i.severe_note ? `<p class="small"><span class="chip" style="border-color:#ffb02066">severe service</span> ${h(i.severe_note)}</p>` : ''}
        <p class="small muted">Source: ${i.source === 'manual' ? "owner's manual" : i.source === 'typical' ? 'typical interval (not in the manual), verify' : i.source === 'user' ? 'added by you' : 'typical interval, verify against the manual'}</p>
        <h3 style="font-size:1rem;margin-top:10px">History</h3>
        ${i.history.length ? `<ul class="list small">${i.history.map(s => `<li><span>${fmtDate(s.date)}${s.mileage != null ? ` @ ${miles(s.mileage)}` : ''}</span><span class="grow">${h(s.title)}</span></li>`).join('')}</ul>` : '<p class="small muted">No service logged for this yet.</p>'}
        <div class="row" style="margin-top:10px">
          <button class="btn sm primary" data-act="log">Log service</button>
          <button class="btn sm" data-act="last">Set last done</button>
          <button class="btn sm" data-act="edit">Edit</button>
          <button class="btn sm danger" data-act="del">Delete</button>
        </div>
      </div></details>`).join('')}`;
  document.getElementById('add-item').onclick = () => modal('Add schedule item', itemForm(), {
    onSubmit: async f => { await api(`/api/cars/${c.id}/items`, { method: 'POST', body: f }); toast('Added', true); reload(); },
  });
  el.onclick = safe(async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const it = d.items.find(i => i.id === b.closest('[data-id]').dataset.id);
    if (b.dataset.act === 'log') return logService(d, { item_ids: [it.id], title: it.name }, reload);
    if (b.dataset.act === 'last') return modal(`Last done: ${it.name}`, `<div class="row">${field('Date', 'last_done_date', it.last_done_date || TODAY, 'date')}${field('Mileage', 'last_done_miles', it.last_done_miles ?? c.mileage ?? '', 'number', 'min="0" inputmode="numeric"')}</div>
      <p class="small muted">Tip: logging a service in History does this automatically and keeps a record.</p>`, {
      onSubmit: async f => { await api(`/api/items/${it.id}`, { method: 'PATCH', body: { ...f, due_now: false } }); reload(); },
    });
    if (b.dataset.act === 'edit') return modal('Edit schedule item', itemForm(it), {
      onSubmit: async f => { await api(`/api/items/${it.id}`, { method: 'PATCH', body: f }); reload(); },
    });
    if (b.dataset.act === 'del') return modal('Delete schedule item?', `<p>Remove <strong>${h(it.name)}</strong> from the schedule? Service history stays.</p>`, {
      submit: 'Delete', danger: true, onSubmit: async () => { await api(`/api/items/${it.id}`, { method: 'DELETE' }); reload(); },
    });
  });
}

function serviceForm(d, s = {}) {
  const ids = new Set(s.item_ids || []);
  return `<div class="row">${field('Date', 'date', s.date || TODAY, 'date', 'required')}${field('Mileage', 'mileage', s.mileage ?? d.car.mileage ?? '', 'number', 'min="0" inputmode="numeric"')}</div>
    ${field('What was done', 'title', s.title || '', 'text', 'required maxlength="160" placeholder="e.g. Oil & filter change"')}
    ${area('Details', 'details', s.details || '')}
    ${field('Parts', 'parts', s.parts || '', 'text', 'placeholder="brand, part numbers, quantities"')}
    <div class="row">${field('Cost ($)', 'cost', s.cost_cents != null ? (s.cost_cents / 100).toFixed(2) : '', 'text', 'inputmode="decimal"')}${field('Shop', 'shop', s.shop || '', 'text', 'placeholder="Leave empty for DIY"')}</div>
    <label class="check"><input type="checkbox" name="diy" ${s.diy ? 'checked' : ''}> DIY</label>
    <div class="field"><label>Counts as (marks these schedule items done)</label>
      <div style="max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:6px 10px">${d.items.map(i => `<label class="check"><input type="checkbox" name="item_ids" data-multi="1" value="${i.id}" ${ids.has(i.id) ? 'checked' : ''}> ${h(i.name)}</label>`).join('') || '<span class="muted small">No schedule items.</span>'}</div></div>
    <div class="field"><label for="f-receipts">Receipt photos / PDF</label><input id="f-receipts" type="file" accept="image/*,application/pdf" multiple></div>`;
}
async function uploadReceipts(serviceId, form) {
  const files = [...(form.querySelector('#f-receipts')?.files || [])];
  for (const f of files) await api(`/api/services/${serviceId}/files`, { method: 'POST', raw: f });
  return files.length;
}
function logService(d, preset, reload) {
  modal('Log service', serviceForm(d, preset), {
    wide: true,
    onSubmit: async (f, form) => {
      const { id } = await api(`/api/cars/${d.car.id}/services`, { method: 'POST', body: f });
      const n = await uploadReceipts(id, form);
      toast(`Logged${n ? ` with ${n} file${n > 1 ? 's' : ''}` : ''}`, true); reload();
    },
  });
}

async function tabHistory(el, d, reload) {
  const names = Object.fromEntries(d.items.map(i => [i.id, i.name]));
  const total = d.services.reduce((n, s) => n + (s.cost_cents || 0), 0);
  el.innerHTML = `<div class="section-title" style="margin-top:0"><h2>Service history</h2><span class="row" style="gap:8px">${scanBtn(d.car.id, 'sm', 'Scan receipt')}<button class="btn sm primary" id="log">Log service</button></span></div>
    ${total ? `<p class="small muted">Total recorded: ${money(total)}</p>` : ''}
    ${d.services.length ? d.services.map(s => { const dg = (d.diagnoses || []).find(x => x.service_id === s.id); return `<article class="svc${dg ? ' dg-svc' : ''}" data-id="${s.id}">
      <div class="row" style="align-items:baseline"><span class="when">${fmtDate(s.date)}${s.mileage != null ? ` · ${miles(s.mileage)}` : ''}</span><strong style="flex:1">${h(s.title)}</strong>
        <span class="small muted">${s.diy ? 'DIY' : h(s.shop || '')}${s.cost_cents != null ? ` · ${money(s.cost_cents)}` : ''}</span></div>
      ${dg ? `<div><span class="chip dg-chip">${DIAG_ICON} guided diagnosis</span> <a class="small" href="#/diag/${dg.session_id}">Open the checks ›</a></div>` : ''}
      ${s.details ? `<div class="details">${h(s.details)}</div>` : ''}
      ${s.parts ? `<div class="small"><span class="muted">Parts:</span> ${h(s.parts)}</div>` : ''}
      ${s.item_ids.length ? `<div>${s.item_ids.map(i => `<span class="chip">${h(names[i] || 'item')}</span>`).join('')}</div>` : ''}
      ${s.files.length ? `<div class="thumbs">${s.files.map(f => `<a href="/api/files/${f.id}" target="_blank" rel="noopener">${f.content_type.startsWith('image/') && !/hei[cf]/.test(f.content_type) ? `<img src="/api/files/${f.id}" alt="${h(f.filename)}" loading="lazy">` : `<span class="doc">${h(f.filename)}</span>`}</a>`).join('')}</div>` : ''}
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="edit">Edit</button><label class="btn sm">Add receipt<input type="file" accept="image/*,application/pdf" multiple class="sr" data-act="file"></label><button class="btn sm danger" data-act="del">Delete</button></div>
    </article>`; }).join('') : '<p class="muted">No history yet.</p>'}`;
  document.getElementById('log').onclick = () => logService(d, {}, reload);
  el.onclick = safe(async e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const s = d.services.find(x => x.id === b.closest('[data-id]').dataset.id);
    if (b.dataset.act === 'edit') return modal('Edit service', serviceForm(d, s), {
      wide: true,
      onSubmit: async (f, form) => { await api(`/api/services/${s.id}`, { method: 'PATCH', body: { ...f, diy: !!f.diy } }); await uploadReceipts(s.id, form); reload(); },
    });
    if (b.dataset.act === 'del') return modal('Delete this entry?', `<p>Delete <strong>${h(s.title)}</strong> (${fmtDate(s.date)}) and its receipts?</p>`, {
      submit: 'Delete', danger: true, onSubmit: async () => { await api(`/api/services/${s.id}`, { method: 'DELETE' }); reload(); },
    });
  });
  el.onchange = safe(async e => {
    if (e.target.dataset.act !== 'file') return;
    const id = e.target.closest('[data-id]').dataset.id;
    for (const f of e.target.files) await api(`/api/services/${id}/files`, { method: 'POST', raw: f });
    toast('Receipt added', true); reload();
  });
}

const SAFE = { yes: ['ok', 'OK to drive'], caution: ['soon', 'Drive with caution'], no: ['overdue', "Don't drive it"] };
function researchBlock(t) {
  const j = t.research;
  const btn = label => `<button class="btn sm" data-act="research">${label}</button>`;
  if (!j) return `<div class="rr-actions">${btn('Research this')}<span class="small muted">Deep web research (forums, TSBs, repair sites) by ${CONFIG.research_worker ? 'your research computer; takes ~10 min' : 'your Claude'}.</span></div>`;
  if (j.status === 'queued' || j.status === 'running') return `<div class="rr pending"><div class="who">Research report</div><p class="thinking">${j.status === 'queued' ? (CONFIG.research_worker ? 'Queued for research (your research computer checks every 5 minutes)' : 'Waiting for research: ask your Claude to "research the waiting symptoms" (Claude Code or a Claude app with this garage connected)') : 'Researching now (usually 5–15 minutes)'}</p>${j.error ? `<p class="small muted">${h(j.error)}</p>` : ''}</div>`;
  if (j.status === 'failed') return `<div class="rr error"><div class="who">Research report</div><p>Research failed, try again.</p><p class="small muted">${h(j.error || '')}</p>${btn('Try again')}</div>`;
  const r = j.report, sd = SAFE[r.safe_to_drive.verdict] || SAFE.caution;
  return `<details class="rr" ${j.seen_at ? '' : 'open'} data-job="${j.id}" data-unseen="${j.seen_at ? '' : '1'}"><summary><span class="who">Research report</span> ${pill(sd[0], sd[1])} <span class="small muted">${fmtTs(j.finished_at)}</span>${j.seen_at ? '' : ' <span class="badge">new</span>'}</summary>
    <p>${h(r.summary)}</p>
    ${r.safe_to_drive.why ? `<p class="small"><strong>${sd[1]}:</strong> ${h(r.safe_to_drive.why)}</p>` : ''}
    ${r.check_order.length ? `<h4>Check in this order (cheapest first)</h4><ol class="small">${r.check_order.map(x => `<li>${h(x)}</li>`).join('')}</ol>` : ''}
    <h4>Likely causes</h4><ul class="list">${r.likely_causes.map(c => `<li><div class="grow"><strong>${h(c.cause)}</strong> ${pill(c.likelihood === 'high' ? 'overdue' : c.likelihood === 'med' ? 'soon' : 'unknown', c.likelihood)} <span class="small muted">DIY difficulty ${c.diy_difficulty}/5 · DIY ${h(c.cost_diy || '?')} · shop ${h(c.cost_shop || '?')}</span>
      ${c.why ? `<div class="small">${h(c.why)}</div>` : ''}${c.how_to_check ? `<div class="small"><span class="muted">Check:</span> ${h(c.how_to_check)}</div>` : ''}${c.fix ? `<div class="small"><span class="muted">Fix:</span> ${h(c.fix)}</div>` : ''}</div></li>`).join('')}</ul>
    ${r.parts.length ? `<h4>Parts</h4><ul class="small">${r.parts.map(p => `<li>${p.link ? `<a href="${hu(p.link)}" target="_blank" rel="noopener noreferrer">${h(p.name)}</a>` : h(p.name)}${p.part_numbers ? ` · ${h(p.part_numbers)}` : ''}${p.approx_price ? ` · ${h(p.approx_price)}` : ''}</li>`).join('')}</ul><p class="small muted">Confirm part numbers for your VIN before buying.</p>` : ''}
    ${r.videos.length ? `<h4>Videos</h4><ul class="small">${r.videos.map(v => `<li><a href="${hu(v.url)}" target="_blank" rel="noopener noreferrer">${h(v.title)}</a>${v.channel ? ` <span class="muted">· ${h(v.channel)}</span>` : ''}</li>`).join('')}</ul>` : ''}
    ${r.questions_for_owner.length ? `<h4>Questions for you</h4><ul class="small">${r.questions_for_owner.map(q => `<li>${h(q)}</li>`).join('')}</ul>` : ''}
    <h4>Sources</h4><div class="small">${r.sources.map(x => `<a href="${hu(x.url)}" target="_blank" rel="noopener noreferrer" title="${h(x.url)}">${h(x.title)}</a>`).join(' · ')}</div>
    <div class="rr-actions">${btn('Research again')}</div></details>`;
}

async function tabTodo(el, d, reload) {
  const open = d.todos.filter(t => t.status === 'open'), closed = d.todos.filter(t => t.status === 'closed');
  const [pgd, dgx] = await Promise.all([loadParts(d.car.id).catch(() => ({ data: null })), api(`/api/cars/${d.car.id}/diagnoses`).catch(() => ({ plans: [], sessions: [] }))]);
  const openDiag = t => dgx.sessions.find(s => s.status === 'active' && s.todo_id === t.id);
  const guideLinks = {};
  if (pgd.data) for (const t of d.todos) guideLinks[t.id] = guidesFor(t, pgd.data.guides);
  const sym = t => {
    if (t.type !== 'symptom') return '';
    const sy = t.symptom || {};
    const tags = [...(sy.kind || []).map(k => KINDS[k]), ...(sy.when || []).map(k => WHENS[k]), ...(sy.where || []).map(k => WHERES[k])].filter(Boolean);
    return `${tags.length ? `<div>${tags.map(x => `<span class="chip">${h(x)}</span>`).join('')}</div>` : ''}
      <div class="small muted">Reported ${t.reporter ? `by ${h(t.reporter)} ` : ''}${fmtTs(t.created_at)}${t.mileage ? ` at ${miles(t.mileage)}` : ''}</div>
      ${t.files?.length ? `<div class="thumbs">${t.files.map(f => `<a href="/api/files/${f.id}" target="_blank" rel="noopener">${f.content_type.startsWith('video/') ? `<video src="/api/files/${f.id}" muted playsinline preload="metadata"></video>` : /hei[cf]/.test(f.content_type) ? `<span class="doc">${h(f.filename)}</span>` : `<img src="/api/files/${f.id}" alt="${h(f.filename)}" loading="lazy">`}</a>`).join('')}</div>` : ''}
      <div class="ai-note ${t.ai_status || ''}"><div class="who">Mechanic's first checks</div>${t.ai_status === 'pending' ? '<p class="thinking">The mechanic is looking at it</p>' : `${t.ai_status === 'error' ? `<p class="small">${h(t.ai_error || t.ai_note || "The mechanic couldn't answer just now.")}</p>` : ''}${t.ai_note && !(t.ai_status === 'error' && !t.ai_error) ? md(t.ai_note) : t.ai_status === 'error' ? '' : '<p class="muted small">No note yet.</p>'}`}
        ${t.ai_status === 'truncated' ? '<div class="cutoff" role="status"><span>The note was cut off.</span> <button class="btn sm primary" data-act="reask" data-cont="1">Tap to continue</button></div>' : ''}
        ${t.ai_status === 'error' || (t.status === 'open' && t.ai_status === 'done') ? `<button class="btn sm ghost" data-act="reask">${t.ai_status === 'error' ? 'Try again' : 'Ask again'}</button>` : ''}${t.ai_note ? disclaimerNote() : ''}</div>`;
  };
  const row = t => `<div class="todo ${t.status}" data-id="${t.id}">
    <button class="box" data-act="toggle" aria-label="${t.status === 'open' ? 'Mark done' : 'Reopen'}"></button>
    <div class="grow" style="flex:1;min-width:0"><div class="row" style="align-items:center;gap:8px"><span class="title">${h(t.title)}</span>${t.type === 'symptom' ? '<span class="chip symptom-chip">symptom</span>' : ''}${pill(t.priority, t.priority)}${t.dtc_code ? `<span class="chip">${h(t.dtc_code)}</span>` : ''}</div>
      ${t.notes && t.type !== 'symptom' ? `<div class="notes">${h(t.notes)}</div>` : ''}${t.type === 'symptom' ? `<div class="notes">${h(t.notes)}</div>` : ''}
      ${sym(t)}
      ${t.status === 'open' || t.research ? researchBlock(t) : ''}
      ${t.status === 'open' && /tick/i.test(t.title) && pgd.brands?.meta?.oil_filter_tick ? oilFilterTick(pgd.brands.meta.oil_filter_tick) : ''}
      ${t.status === 'open' && guideLinks[t.id]?.length ? `<div class="small guide-links">Guides: ${guideLinks[t.id].map(x => `<a href="#/car/${d.car.id}/guides" data-guide="${x.i}">${h(x.g.title)}</a>`).join(' · ')}</div>` : ''}
      <div class="row" style="margin-top:6px">${t.status === 'open' && openDiag(t) ? `<a class="btn sm primary" href="#/diag/${openDiag(t).session_id}">${DIAG_ICON} Resume diagnosis</a>` : t.status === 'open' && todoLooksLikeSymptom(t, dgx.plans) ? diagBtn(d.car.id, t.id, 'Diagnose', 'sm primary') : ''}<button class="btn sm ghost" data-act="edit">Edit</button>${t.status === 'open' ? `<a class="btn sm ghost" href="#/car/${d.car.id}/mechanic" data-ask="${h(t.title)}">Ask the mechanic</a>` : ''}<button class="btn sm ghost danger" data-act="del">Delete</button></div></div></div>`;
  el.innerHTML = `<div class="symptom-bar">${symptomBtn(d.car.id)}</div><div class="section-title" style="margin-top:0"><h2>Open</h2><button class="btn sm" id="add">Add to-do</button></div>
    ${open.length ? open.map(row).join('') : '<p class="muted">Nothing open.</p>'}
    ${closed.length ? `<details style="margin-top:16px"><summary class="muted" style="cursor:pointer">Done (${closed.length})</summary>${closed.map(row).join('')}</details>` : ''}`;
  pollCount = 0; pollAi(open.filter(t => t.ai_status === 'pending').map(t => t.id));
  // mark freshly shown reports as seen
  for (const x of el.querySelectorAll('.rr[data-unseen="1"]')) api(`/api/research-jobs/${x.dataset.job}/seen`, { method: 'POST', body: {} }).catch(() => {});
  const form = (t = {}) => `${field('What needs doing', 'title', t.title || '', 'text', 'required maxlength="200"')}
    <div class="field"><label for="f-priority">Priority</label><select id="f-priority" name="priority">${['high', 'medium', 'low'].map(p => `<option ${p === (t.priority || 'medium') ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
    ${area('Notes', 'notes', t.notes || '', 'rows="6"')}`;
  document.getElementById('add').onclick = () => modal('Add to-do', form(), { onSubmit: async f => { await api(`/api/cars/${d.car.id}/todos`, { method: 'POST', body: f }); reload(); } });
  el.onclick = safe(async e => {
    const gl = e.target.closest('[data-guide]');
    if (gl) { store.set('garage.guide', gl.dataset.guide); return; }
    const ask = e.target.closest('[data-ask]');
    if (ask) { store.set(`ask.${d.car.id}`, `Help me with this issue: ${ask.dataset.ask}. Where should I start?`); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const t = d.todos.find(x => x.id === b.closest('[data-id]').dataset.id);
    if (b.dataset.act === 'research') { const r = await api(`/api/todos/${t.id}/research`, { method: 'POST', body: {} }); toast(r.duplicate ? 'Already queued' : 'Queued for research', true); return reload(); }
    if (b.dataset.act === 'reask') { await api(`/api/todos/${t.id}/ask`, { method: 'POST', body: b.dataset.cont ? { continue: true } : {} }); return reload(); }
    if (b.dataset.act === 'toggle') {
      if (t.status === 'closed') { await api(`/api/todos/${t.id}`, { method: 'PATCH', body: { status: 'open' } }); return reload(); }
      return modal('Mark done', `<p><strong>${h(t.title)}</strong></p>
        <label class="check"><input type="checkbox" name="to_history" id="to-hist" checked> Also add it to the service history</label>
        <div id="hist-fields">${serviceForm(d, { title: t.title, details: '' })}</div>`, {
        submit: 'Done', wide: true,
        onOpen: f => { f.querySelector('#to-hist').onchange = ev => { f.querySelector('#hist-fields').classList.toggle('hidden', !ev.target.checked); }; },
        onSubmit: async (f, formEl) => {
          const body = { status: 'closed' };
          if (f.to_history) { const { to_history, ...hist } = f; body.history = hist; }
          const r = await api(`/api/todos/${t.id}`, { method: 'PATCH', body });
          if (r.service_id) await uploadReceipts(r.service_id, formEl);
          toast('Done', true); reload();
        },
      });
    }
    if (b.dataset.act === 'edit') return modal('Edit to-do', form(t), { onSubmit: async f => { await api(`/api/todos/${t.id}`, { method: 'PATCH', body: f }); reload(); } });
    if (b.dataset.act === 'del') return modal('Delete to-do?', `<p>${h(t.title)}</p>`, { submit: 'Delete', danger: true, onSubmit: async () => { await api(`/api/todos/${t.id}`, { method: 'DELETE' }); reload(); } });
  });
}

async function tabMechanic(el, d) {
  const c = d.car;
  let { chats } = await api(`/api/cars/${c.id}/chats`);
  let current = chats[0]?.id || null;
  const open = d.todos.filter(t => t.status === 'open');
  const starters = [
    ...open.slice(0, 3).map(t => `Where should I start on: ${t.title}?`),
    'What maintenance should I prioritize with what\'s overdue?',
    'What should I check before a long road trip?',
  ];
  el.innerHTML = `<div class="chat-wrap">
    <div><button class="btn sm primary" id="new-chat" style="width:100%;margin-bottom:8px">New conversation</button><nav class="chat-list" id="chat-list"></nav></div>
    <section class="chat"><div class="msgs" id="msgs"></div>
      <div class="starters" id="starters"></div>
      <form class="composer" id="composer"><textarea id="q" rows="2" placeholder="Describe the symptom: when it happens, sounds, smells, warning lights…" maxlength="4000" aria-label="Your question"></textarea><button class="btn primary" type="submit">Ask</button></form>
      <p class="small muted">AI answers can be wrong. It knows this car's issues, history and scan codes, but verify specs and part numbers in a service manual. Safety first: never work under a car held only by a jack.</p>
    </section></div>`;
  const list = document.getElementById('chat-list'), msgs = document.getElementById('msgs'), q = document.getElementById('q');
  let busy = false;
  const drawList = () => { list.innerHTML = chats.map(ch => `<a href="#" data-chat="${ch.id}" class="${ch.id === current ? 'on' : ''}" title="${h(ch.title)}">${h(ch.title)}</a>`).join('') || '<span class="small muted">No conversations yet.</span>'; };
  const CUT = '<div class="cutoff" role="status"><span>The answer was cut off.</span> <button type="button" class="btn sm primary" data-cont="1">Tap to continue</button></div>';
  const NOANS = msg => `<div class="cutoff" role="status"><span>${h(msg || "The mechanic didn't answer that one.")}</span> <button type="button" class="btn sm primary" data-cont="1">Try again</button></div>`;
  const bubble = m => `<div class="msg ${m.role}">${m.role === 'assistant' ? `<div class="who">Mechanic</div><div class="ans">${md(m.content)}</div>${m.truncated ? CUT : ''}${disclaimerNote()}` : h(m.content)}</div>`;
  const loadChat = async () => {
    drawList();
    document.getElementById('starters').innerHTML = current ? '' : starters.map(s => `<button type="button">${h(s)}</button>`).join('');
    if (!current) { msgs.innerHTML = `<div class="msg assistant"><div class="who">Mechanic</div><p>Hey. I know your ${h(ymm(c))} at ${miles(c.mileage)}, its open issues and history. What's it doing?</p></div>`; return; }
    const { messages } = await api(`/api/chats/${current}`);
    // only the last answer can be continued; a question with no answer after it gets "Try again"
    msgs.innerHTML = messages.map((m, i) => bubble({ ...m, truncated: m.truncated && i === messages.length - 1 })).join('')
      + (messages.at(-1)?.role === 'user' ? `<div class="msg assistant"><div class="who">Mechanic</div><div class="ans"></div>${NOANS()}</div>` : '');
    msgs.lastElementChild?.scrollIntoView({ block: 'end' });
  };
  /** POST and render the NDJSON answer stream into the bubble `box` (append = continue the text already there). */
  const streamInto = async (box, path, body, prev = '') => {
    const ans = box.querySelector('.ans');
    box.querySelector('.cutoff')?.remove();
    let answer = prev, status = 'failed', err = '', note = '', last = 0;
    const paint = () => { ans.innerHTML = (answer ? md(answer) : '<span class="thinking">Thinking</span>') + (note ? `<p class="small muted">${h(note)}</p>` : ''); };
    paint();
    try {
      const r = await api(path, { method: 'POST', body, stream: true });
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.t === 'c') { answer += ev.d; note = ''; }
          else if (ev.t === 'reset') answer = '';
          else if (ev.t === 'status') note = ev.msg;
          else if (ev.t === 'error') err = ev.message;
          else if (ev.t === 'done') status = ev.status;
        }
        if (Date.now() - last > 60) { paint(); last = Date.now(); }
      }
    } catch (e) { err = e.message; }
    note = '';
    if (status === 'failed') { answer = prev; paint(); if (!prev) ans.innerHTML = ''; box.insertAdjacentHTML('beforeend', prev ? CUT : NOANS(err || 'The mechanic couldn\'t answer just now.')); }
    else { paint(); if (status === 'truncated') box.insertAdjacentHTML('beforeend', CUT); }
    return status;
  };
  msgs.onclick = safe(async e => {
    const b = e.target.closest('[data-cont]'); if (!b || busy || !current) return;
    busy = true;
    try {
      const box = b.closest('.msg');
      const last = (await api(`/api/chats/${current}`)).messages.at(-1);   // raw markdown of the cut-off answer
      await streamInto(box, `/api/chats/${current}/continue`, {}, last?.role === 'assistant' && last.truncated ? last.content : '');
    } finally { busy = false; }
  });
  document.getElementById('new-chat').onclick = () => { current = null; loadChat(); q.focus(); };
  list.onclick = safe(async e => { const a = e.target.closest('[data-chat]'); if (!a) return; e.preventDefault(); current = a.dataset.chat; await loadChat(); });
  document.getElementById('starters').onclick = e => { const b = e.target.closest('button'); if (b) { q.value = b.textContent; q.focus(); } };
  q.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) document.getElementById('composer').requestSubmit(); });
  document.getElementById('composer').onsubmit = safe(async e => {
    e.preventDefault();
    const text = q.value.trim(); if (!text || busy) return;
    busy = true;
    try {
      if (!current) { const { id } = await api(`/api/cars/${c.id}/chats`, { method: 'POST', body: {} }); current = id; chats.unshift({ id, title: text.slice(0, 60) }); drawList(); document.getElementById('starters').innerHTML = ''; msgs.innerHTML = ''; }
      q.value = '';
      msgs.insertAdjacentHTML('beforeend', bubble({ role: 'user', content: text }));
      msgs.insertAdjacentHTML('beforeend', `<div class="msg assistant"><div class="who">Mechanic</div><div class="ans"></div>${disclaimerNote()}</div>`);
      const box = msgs.lastElementChild;
      box.scrollIntoView({ block: 'end' });
      await streamInto(box, `/api/chats/${current}/messages`, { content: text });
      ({ chats } = await api(`/api/cars/${c.id}/chats`)); drawList();
    } finally { busy = false; }
  });
  const pre = store.get(`ask.${c.id}`);
  if (pre) { current = null; store.set(`ask.${c.id}`, ''); }
  await loadChat();
  if (pre) q.value = pre;
}

// ---------------------------------------------------------------- research tab
/** "60k-200k" | "100k+" | "avg 126k" | "any" -> [start, end|null] in miles, or null when not mileage-based. */
export function parseRange(s) {
  const t = String(s || '').toLowerCase().replace(/,/g, '');
  let m = t.match(/(\d+(?:\.\d+)?)\s*k?\s*[-–]\s*(\d+(?:\.\d+)?)\s*k(\+)?/);
  if (m) return [m[1] * 1000, m[3] ? null : m[2] * 1000];
  m = t.match(/(\d+(?:\.\d+)?)\s*k\s*\+/);
  if (m) return [m[1] * 1000, null];
  const avg = [...t.matchAll(/avg\s*(\d+(?:\.\d+)?)\s*k/g)].map(x => x[1] * 1000);
  if (avg.length) return [Math.min(...avg) * 0.8, Math.max(...avg) * 1.2];
  m = t.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (m) return [m[1] * 1000, null];
  return null;
}
const GK_RE = /\[?\(?\s*general knowledge\s*\)?\]?/i;
const gk = s => { const t = h(s); return GK_RE.test(String(s || '')) ? t.replace(/\[?\(?\s*general knowledge\s*\)?\]?/gi, '<span class="pill unknown" title="Not from a cited source">general knowledge</span>') : t; };
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'source'; } };
const srcLinks = list => (list || []).length ? `<div class="small">${(Array.isArray(list) ? list : [list]).map(u => /^https?:/.test(u) ? `<a href="${hu(u)}" target="_blank" rel="noopener noreferrer">${h(hostOf(u))}</a>` : h(u)).join(' · ')}</div>` : '';
const flatText = v => v == null ? '' : Array.isArray(v) ? v.map(flatText).join('; ') : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k.replace(/_/g, ' ')}: ${flatText(x)}`).join('; ') : String(v);
const PRIO = [['now', 'Do now', 'overdue'], ['soon', 'Soon', 'soon'], ['decision', 'Decision', 'soon'], ['watch', 'Watch', 'ok'], ['skip', 'Skip', 'unknown']];

async function tabResearch(el, d) {
  const c = d.car;
  const { data: r, md: report } = await api(`/api/cars/${c.id}/research`);
  if (!r) { el.innerHTML = '<p class="muted">No research loaded for this car yet.</p>'; return; }
  const disc = disclaimerNote('card disclaimer-top');
  const M = c.mileage || 0;
  const v = r.vehicle || {};
  const issues = (r.known_issues || []).map(k => ({ ...k, range: parseRange(k.mileage_range) }));
  const phase = k => !k.range ? 'any' : (k.range[1] != null && k.range[1] < M) ? 'behind' : k.range[0] <= M ? 'now' : 'ahead';
  const scaleMax = Math.max(300000, M * 1.25, ...issues.filter(k => k.range).map(k => (k.range[1] || k.range[0]) * 1.05));
  const pct = x => `${Math.max(0, Math.min(100, (x / scaleMax) * 100)).toFixed(1)}%`;
  const issueRow = k => `<div class="ki ${phase(k)}">
      <div class="ki-head"><strong>${gk(k.title)}</strong> <span class="pill ${/high/i.test(k.urgency) ? 'overdue' : /medium/i.test(k.urgency) ? 'soon' : 'unknown'}">${h(clip(k.urgency, 40))}</span></div>
      ${k.range ? `<div class="ki-track" aria-hidden="true"><i class="ki-bar" style="left:${pct(k.range[0])};width:calc(${pct((k.range[1] ?? scaleMax) - k.range[0])})"></i><b class="ki-now" style="left:${pct(M)}"></b></div>` : ''}
      <div class="small muted">${h(k.mileage_range)}</div>
      <div class="small"><span class="muted">Symptoms:</span> ${gk(k.symptoms)}</div>
      <div class="small"><span class="muted">Fix:</span> ${gk(k.fix)}</div>
      <div class="small"><span class="muted">Cost:</span> DIY ${gk(k.cost_diy || '?')} · shop ${gk(k.cost_shop || '?')}</div>
      ${srcLinks(k.sources)}</div>`;
  const group = (title, list, note = '') => list.length ? `<h3 class="ki-group">${title} <span class="muted small">(${list.length})</span></h3>${note}${list.map(issueRow).join('')}` : '';
  const specs = ['trim', 'trim_likely', 'trim_reported', 'engine', 'engine_likely', 'engine_alternative', 'transmission', 'transmission_likely', 'drive', 'oil', 'coolant', 'spark_plug_gap_in', 'capacities', 'fluids', 'parts', 'climate_control', 'instrument_cluster', 'platform'];
  const nh = v.nhtsa_counts || r.nhtsa_complaints;
  el.innerHTML = `${disc}
    <div class="grid2">
      <section class="card"><h2>Specs (researched)</h2>
        <table class="codes"><tbody>${specs.filter(k => v[k] != null).map(k => `<tr><th style="width:34%">${h(k.replace(/_/g, ' '))}</th><td>${gk(flatText(v[k]))}</td></tr>`).join('')}</tbody></table>
        ${srcLinks(v.sources)}
        ${nh ? `<p class="small muted">NHTSA: ${h(flatText(Object.fromEntries(Object.entries(nh).filter(([k, x]) => typeof x !== 'object' || k === 'by_component').slice(0, 6))).slice(0, 400))}</p>` : ''}
      </section>
      <section class="card"><h2>Recommendations</h2>
        ${PRIO.map(([p, label, cls]) => { const list = (r.recommendations || []).filter(x => x.priority === p); return list.length ? `<h3 class="ki-group">${pill(cls, label)}</h3><ul class="list">${list.map(x => `<li><div class="grow"><strong>${gk(x.item)}</strong><div class="small muted">${gk(x.why || '')}${x.cost ? ` · ${gk(x.cost)}` : ''}</div></div></li>`).join('')}</ul>` : ''; }).join('')}
        ${(r.recommendations || []).filter(x => !PRIO.some(p => p[0] === x.priority)).map(x => `<p class="small">${h(x.priority)}: ${gk(x.item)}</p>`).join('')}
      </section>
    </div>
    <section class="card"><h2>Known issues by mileage</h2>
      <p class="small muted">Bars show each issue's typical mileage window; the orange line is this car at ${miles(M)}.</p>
      ${group('In its window now', issues.filter(k => phase(k) === 'now'))}
      ${group('Coming up next', issues.filter(k => phase(k) === 'ahead').sort((a, b) => a.range[0] - b.range[0]))}
      ${group('Any mileage / age-related', issues.filter(k => phase(k) === 'any'))}
      ${group('Behind it', issues.filter(k => phase(k) === 'behind'), '<p class="small muted">Typical window has passed; still worth checking if it was never done.</p>')}
    </section>
    <div class="grid2">
      <section class="card"><h2>Recalls</h2>
        <p class="small">Check open recalls by VIN at <a href="https://www.nhtsa.gov/recalls" target="_blank" rel="noopener noreferrer">nhtsa.gov/recalls</a>${c.vin ? ` (VIN ${h(c.vin)})` : ' (add the VIN in Edit car)'}. Recall repairs are free.</p>
        <ul class="list">${(r.recalls || []).map(x => `<li><div class="grow"><strong>${h(x.campaign)}</strong> <span class="small muted">${h(x.date || '')} · ${h(x.component || '')}</span><div class="small">${gk(x.summary)}</div><div class="small muted">${gk(x.remedy || '')}</div>${srcLinks(x.url ? [x.url] : [])}</div></li>`).join('') || '<li class="muted">None found.</li>'}</ul>
      </section>
      <section class="card"><h2>Technical service bulletins</h2>
        <ul class="list">${(r.tsbs || []).map(x => `<li><div class="grow"><details><summary><strong>${h(x.number)}</strong> ${gk(x.title)}</summary><div class="small" style="margin-top:4px">${gk(x.summary || '')}</div>${srcLinks(x.url ? [x.url] : [])}</details></div></li>`).join('') || '<li class="muted">None found.</li>'}</ul>
      </section>
    </div>
    <section class="card"><h2>Symptom diagnosis</h2>
      ${(r.symptom_diagnosis || []).map(s => `<details class="item"><summary><span></span><div class="name">${gk(s.symptom)}</div><span></span></summary><div class="body">
        <ol class="small">${[...(s.likely_causes || [])].map(x => `<li style="margin:6px 0"><strong>${gk(x.cause)}</strong> <span class="muted">(${h(x.likelihood || '?')})</span><br><span class="muted">Check:</span> ${gk(x.how_to_check || '')}<br><span class="muted">Fix:</span> ${gk(x.fix || '')} <span class="muted">· ${gk(x.cost || '')}</span></li>`).join('')}</ol>
        ${s.scan_tool_checks ? `<p class="small"><span class="muted">Scan tool:</span> ${gk(flatText(s.scan_tool_checks))}</p>` : ''}</div></details>`).join('')}
    </section>
    <div class="grid2">
      <section class="card"><h2>Researched schedule</h2>
        <table class="codes"><thead><tr><th>Item</th><th>Interval</th><th>Source</th></tr></thead><tbody>${(r.schedule || []).map(s => `<tr><td>${gk(s.item)}${s.notes ? `<div class="small muted">${gk(s.notes)}</div>` : ''}</td><td style="white-space:nowrap">${[s.interval_miles ? miles(s.interval_miles) : null, s.interval_months ? `${s.interval_months} mo` : null].filter(Boolean).join(' / ') || '—'}</td><td>${h(s.source || '')}${s.severe === true ? ' · severe' : typeof s.severe === 'string' ? `<div class="small muted">severe: ${gk(s.severe)}</div>` : ''}</td></tr>`).join('')}</tbody></table>
      </section>
      <section class="card"><h2>Open questions</h2><ol class="small">${(r.questions || []).map(q => `<li style="margin:4px 0">${gk(q)}</li>`).join('')}</ol></section>
    </div>
    ${report ? `<details class="card"><summary style="cursor:pointer"><strong>Full research report</strong></summary><div class="msg assistant" style="max-width:none;margin-top:10px">${md(report)}</div></details>` : ''}`;
}
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ---------------------------------------------------------------- fluids / parts / guides
const VERIFY_RE = /verify|unconfirmed|unresolved|not confirmed|could not confirm|confidence (medium|low)|probably|uncertain|\(\?\)|\[general knowledge\]/i;
const verifyTag = (on, title = 'The research could not fully confirm this; double-check before buying') => on ? ` <span class="pill unknown vtag" title="${h(title)}">verify</span>` : '';
function fluidsCard(rows, carId, { full = false } = {}) {
  if (!rows?.length) return '';
  return `<section class="card fluids"><div class="section-title" style="margin-top:0"><h2>Fluids</h2>${full ? '' : `<a class="btn sm ghost" href="#/car/${carId}/parts">All parts →</a>`}</div>
    <div class="fl-head" aria-hidden="true"><span>Fluid</span><span>What to buy</span><span>How much</span><span>Notes</span></div>
    ${rows.map(f => `<div class="fl-row">
      <div class="fl-name">${h(f.fluid)}${verifyTag(f.verify)}</div>
      <div class="fl-buy">${h(f.buy)}${f.example ? `<div class="small muted">e.g. ${h(f.example)}</div>` : ''}</div>
      <div class="fl-amt"><span class="fl-big">${h(f.amount)}</span>${f.amount_label ? ` <span class="small muted">(${h(f.amount_label)})</span>` : ''}${f.liters ? `<span class="fl-l">${h(f.liters)}</span>` : ''}
        ${f.total ? `<div class="fl-total"><span class="fl-big2">${h(f.total)}</span> <span class="small muted">${h(f.total_label || 'total')}</span>${f.total_liters ? `<span class="fl-l">${h(f.total_liters)}</span>` : ''}</div>` : ''}</div>
      <div class="fl-notes small">${h(f.notes || '')}</div></div>`).join('')}
    <p class="small muted" style="margin:8px 0 0">From the parts research (owner's manuals and GM/Mopar specs), Nov 2026. "verify" = not fully confirmed.</p></section>`;
}
const PART_GROUPS = ['Fluids', 'Filters', 'Ignition', 'Belts', 'Cooling', 'Brakes', 'Wipers', 'Bulbs', 'Battery', 'Tires', 'HVAC actuators', 'Parts for open issues', 'Other'];
function partGroup(p) {
  const c = `${p.category} ${p.name}`.toLowerCase(), n = p.name.toLowerCase();
  if (/open issue/.test(p.category.toLowerCase())) return 'Parts for open issues';
  if (/hvac|actuator|blend door|mode door/.test(c)) return 'HVAC actuators';
  if (/filter/.test(n)) return 'Filters';
  if (/(fluid|engine oil|gear oil|\batf\b|^coolant$|coolant \()/.test(n) && !/pump|hose|cap|reservoir|line|cooler/.test(n)) return 'Fluids';
  if (/spark|coil|ignition|plug wire/.test(c)) return 'Ignition';
  if (/belt|tensioner|idler/.test(c)) return 'Belts';
  if (/cool|thermostat|water pump|radiator|fan|hose|surge|reservoir/.test(c)) return 'Cooling';
  if (/brake|pad|rotor|caliper/.test(c)) return 'Brakes';
  if (/wiper/.test(c)) return 'Wipers';
  if (/bulb|light|lamp/.test(c)) return 'Bulbs';
  if (/battery/.test(c)) return 'Battery';
  if (/tire|wheel/.test(c)) return 'Tires';
  return 'Other';
}
function asOf(p, d) {
  if (p.price_as_of) return p.price_as_of;
  const m = `${p.price_usd || ''} ${p.notes || ''}`.match(/(?:as of\s*)?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4})/);
  return m ? m[1] : (d.researched || d.research_date || d.compiled || '').toString().slice(0, 40);
}
const linkList = (list, cls = '') => (list || []).map(x => typeof x === 'string' ? { url: x, label: hostOf(x) } : x).filter(x => /^https?:/.test(x.url || '')).map(x => `<a class="${cls}" href="${hu(x.url)}" target="_blank" rel="noopener noreferrer">${h(x.label || x.title || hostOf(x.url))}</a>`).join(' · ');
const usd = v => { const t = String(v).trim(); return /^\d/.test(t) ? `$${t}` : t; };
let PG_CACHE = {};
async function loadParts(carId) { if (!PG_CACHE[carId]) PG_CACHE[carId] = api(`/api/cars/${carId}/parts`); return PG_CACHE[carId]; }

const TIER = { oem: ['ok', 'OEM'], oe_supplier: ['ok', 'OE supplier'], premium: ['soon', 'Premium'], value: ['unknown', 'Value'], store_lifetime: ['unknown', 'Store lifetime'] };
const verdictPill = v => { const t = String(v || ''); if (!t || t === 'n/a') return ''; const cls = /avoid|overpriced/i.test(t) ? 'overdue' : /best value/i.test(t) ? 'ok' : /best quality/i.test(t) ? 'low' : /budget/i.test(t) ? 'soon' : 'unknown'; return `<span class="pill ${cls}">${h(t)}</span>`; };
const UNVER = /unverified|unconfirmed|verify|not verif/i;
function brandRow(o, picked) {
  const tier = TIER[o.tier] || ['unknown', o.tier || '?'];
  const pn = String(o.part_number || '').trim();
  return `<li class="br-row${picked ? ' picked' : ''}"><div class="br-main"><strong>${h(o.brand)}</strong> <span class="pill ${tier[0]} tier">${h(tier[1])}</span>${o.rockauto_tier ? ` <span class="small muted">RockAuto: ${h(o.rockauto_tier)}</span>` : ''} ${verdictPill(o.verdict)}${verifyTag(UNVER.test(`${o.part_number} ${o.where} ${o.price_usd}`))}</div>
    <div class="br-sub small">${pn ? `<code>${h(pn)}</code> <button type="button" class="copy" data-copy="${h(pn.split(/\s*[(/]/)[0])}">Copy</button>` : ''} ${o.price_usd != null && o.price_usd !== '' ? `<strong>${h(usd(o.price_usd))}</strong>` : ''} ${o.where ? `<span class="muted">at ${h(o.where)}</span>` : ''}${o.warranty ? ` <span class="muted">· warranty: ${h(o.warranty)}</span>` : ''}</div>
    ${o.reputation ? `<div class="small muted">${h(o.reputation)}</div>` : ''}${o.sources?.length ? `<div class="small muted">${linkList(o.sources)}</div>` : ''}</li>`;
}
function pickIndex(b) {
  const pick = String(b.pick || '').toLowerCase();
  let i = (b.options || []).findIndex(o => o.part_number && pick.includes(String(o.part_number).toLowerCase().split(/[\s(/]+/)[0]) && !/avoid/i.test(o.verdict || ''));
  if (i < 0) i = (b.options || []).findIndex(o => { const w = String(o.brand || '').toLowerCase().split(/[\s/(]+/)[0]; return w.length > 2 && pick.includes(w) && !/avoid/i.test(o.verdict || ''); });
  return i;
}
function compareBrands(b) {
  if (!b) return '';
  const pi = pickIndex(b);
  return `<details class="cb"><summary>Compare brands <span class="muted">(${(b.options || []).length})</span></summary>
    <div class="cb-pick"><div class="who">What I'd buy</div><p>${h(b.pick || '—')}</p>${pi >= 0 ? `<ul class="br">${brandRow(b.options[pi], true)}</ul>` : ''}${b.note ? `<p class="small muted">${h(b.note)}</p>` : ''}</div>
    <ul class="br">${(b.options || []).map((o, i) => i === pi ? '' : brandRow(o, false)).join('')}</ul>
    ${b.avoid?.length ? `<div class="avoid"><strong>Avoid</strong><ul>${b.avoid.map(a => `<li><strong>${h(a.brand)}</strong>: ${h(a.why || '')}${a.sources?.length ? ` <span class="small">${linkList(a.sources)}</span>` : ''}</li>`).join('')}</ul></div>` : ''}</details>`;
}
function oilFilterTick(t) {
  if (!t) return '';
  const rest = Object.entries(t).filter(([k]) => !['question', 'short_answer', 'sources'].includes(k));
  return `<details class="cb oft"><summary>${h(t.question || "Oil filter question")} <span class="muted">(brand research)</span></summary><div class="cb-pick">
    <p><strong>${h(t.question || '')}</strong></p><p>${h(t.short_answer || '')}</p>
    ${rest.map(([k, v]) => `<p class="small"><span class="muted">${h(k.replace(/_/g, ' '))}:</span> ${Array.isArray(v) ? `<ul>${v.map(x => `<li>${h(typeof x === 'object' ? Object.values(x).join(' — ') : x)}</li>`).join('')}</ul>` : h(typeof v === 'object' ? JSON.stringify(v) : v)}</p>`).join('')}
    ${t.sources?.length ? `<p class="small muted">${linkList(t.sources)}</p>` : ''}</div></details>`;
}

const priceNum = v => { const m = String(v ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
async function tabShopping(el, d) {
  const L = await api(`/api/cars/${d.car.id}/shopping`);
  const row = (l, g, i) => `<li class="sh-row"><label class="check"><input type="checkbox" data-sh="${g}-${i}" data-price="${l.est_price ?? ''}" data-pn="${h(String(l.option.part_number || '').split(/\s*[(/]/)[0])}" ${l.default_selected ? 'checked' : ''}>
      <span><strong>${h(l.part)}</strong> <span class="small muted">${h(l.option.brand)}</span></span></label>
      <div class="small">${l.option.part_number ? `<code>${h(l.option.part_number)}</code> <button type="button" class="copy" data-copy="${h(String(l.option.part_number).split(/\s*[(/]/)[0])}">Copy</button>` : ''} ${l.option.price_usd ? `<strong>${h(usd(l.option.price_usd))}</strong>` : ''} <span class="muted">${h(l.option.where || '')}</span>${verifyTag(UNVER.test(`${l.option.part_number} ${l.option.where} ${l.option.price_usd}`))}</div>
      <div class="small muted">For: ${l.for.map(h).join('; ')}${l.default_selected ? '' : ' · only if the checks point here'}</div></li>`;
  const grp = (title, list, g) => `<section class="card"><div class="section-title" style="margin-top:0"><h2>${title}</h2><span class="sh-total" data-total="${g}"></span></div>${list.length ? `<ul class="list">${list.map((l, i) => row(l, g, i)).join('')}</ul>` : '<p class="muted">Nothing here.</p>'}</section>`;
  el.innerHTML = `<p class="small muted">${h(L.note)}</p>
    <div class="row" style="align-items:center;margin-bottom:10px"><strong class="sh-grand"></strong><button class="btn sm" id="copy-all">Copy all selected part numbers</button></div>
    ${grp('Order on RockAuto', L.rockauto, 'ra')}${grp('Buy locally', L.local, 'lo')}
    ${(L.extras || []).length ? `<section class="card"><div class="section-title" style="margin-top:0"><h2>Tools and extras</h2><span class="sh-total" data-total="ex"></span></div><ul class="list">${L.extras.map((x, i) => `<li class="sh-row"><label class="check"><input type="checkbox" data-sh="ex-${i}" data-price="${priceNum(x.price_usd) ?? ''}" data-pn="${h(x.part_number || '')}" checked>
      <span><strong>${h(x.name)}</strong> <span class="chip">${h(x.kind)}</span></span></label>
      <div class="small">${x.part_number ? `<code>${h(x.part_number)}</code> <button type="button" class="copy" data-copy="${h(x.part_number)}">Copy</button> ` : ''}${x.price_usd ? `<strong>${h(usd(x.price_usd))}</strong> ` : ''}${x.url ? `<a href="${hu(x.url)}" target="_blank" rel="noopener noreferrer">${h(x.where || hostOf(x.url))}</a>` : `<span class="muted">${h(x.where || '')}</span>`}</div>
      ${x.note ? `<div class="small muted">${h(x.note)}</div>` : ''}<button type="button" class="btn sm ghost" data-rm-extra="${h(x.id)}">Remove</button></li>`).join('')}</ul></section>` : ''}`;
  const recalc = () => {
    let grand = 0;
    for (const g of ['ra', 'lo', 'ex']) {
      const t = [...el.querySelectorAll(`[data-sh^="${g}-"]:checked`)].reduce((n, c) => n + (Number(c.dataset.price) || 0), 0);
      grand += t; const x = el.querySelector(`[data-total="${g}"]`); if (x) x.textContent = `≈ $${t.toFixed(2)}`;
    }
    el.querySelector('.sh-grand').textContent = `Estimated total (selected): ≈ $${grand.toFixed(2)}`;
  };
  el.onchange = recalc; recalc();
  el.onclick = async e => {
    const c = e.target.closest('[data-copy]');
    if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy'; }, 1500); } catch { toast('Copy failed'); } return; }
    const rm = e.target.closest('[data-rm-extra]');
    if (rm) { try { await api(`/api/shopping-extras/${rm.dataset.rmExtra}`, { method: 'DELETE' }); render(); } catch (err) { toast(err.message); } return; }
    if (e.target.id === 'copy-all') {
      const pns = [...el.querySelectorAll('[data-sh]:checked')].map(x => x.dataset.pn).filter(Boolean);
      try { await navigator.clipboard.writeText(pns.join('\n')); toast(`Copied ${pns.length} part numbers`, true); } catch { toast('Copy failed'); }
    }
  };
}

async function tabParts(el, d) {
  const { data: pg, fluids, brands } = await loadParts(d.car.id);
  if (!pg) { el.innerHTML = '<p class="muted">No parts research loaded for this car yet.</p>'; return; }
  const groups = {};
  const bp = brands?.parts || [];
  const parts = [...pg.parts, ...bp.filter(b => !b.matched_part).map(b => ({ name: b.part, category: b.category || 'Other', spec: '', part_numbers: [], brand_only: true }))];
  for (const p of parts) (groups[partGroup(p)] ||= []).push(p);
  const partCard = p => {
    const txt = `${p.spec || ''} ${p.notes || ''} ${(p.part_numbers || []).map(x => `${x.brand} ${x.number}`).join(' ')}`;
    return `<article class="part"><div class="part-head"><strong>${h(p.name)}</strong>${verifyTag(VERIFY_RE.test(txt))}<span class="small muted part-cat">${h(p.category)}</span></div>
      ${p.spec ? `<div class="small">${h(p.spec)}</div>` : ''}
      ${(p.part_numbers || []).length ? `<ul class="pn">${p.part_numbers.map(x => `<li><span class="muted">${h(x.brand || '')}</span> <code>${h(x.number || '')}</code> <button type="button" class="copy" data-copy="${h(String(x.number || '').replace(/\s*\(.*$/, ''))}" aria-label="Copy part number">Copy</button></li>`).join('')}</ul>` : ''}
      ${p.price_usd ? `<div class="small"><span class="muted">Price:</span> ${h(usd(p.price_usd))} <span class="muted">(as of ${h(asOf(p, pg))})</span></div>` : ''}
      ${p.links?.length ? `<div class="small"><span class="muted">Buy:</span> ${linkList(p.links)}</div>` : ''}
      ${p.notes ? `<div class="small muted">${h(p.notes)}</div>` : ''}
      ${p.source_urls?.length ? `<div class="small muted">Sources: ${linkList(p.source_urls)}</div>` : ''}
      ${p.brand_only ? '<div class="small muted">Added from the brand comparison.</div>' : ''}
      ${compareBrands(bp.find(b => b.matched_part === p.name || (p.brand_only && b.part === p.name)))}
      ${/oil filter/i.test(p.name) ? oilFilterTick(brands?.meta?.oil_filter_tick) : ''}</article>`;
  };
  const bnotes = brands?.meta?.notes || [];
  el.innerHTML = `${fluidsCard(fluids, d.car.id, { full: true })}
    <div class="card callahead"><strong>Brand comparisons:</strong> RockAuto options are listed first. Local store prices and stock (AutoZone, NAPA, O'Reilly) were mostly <strong>not verifiable online</strong> (their sites blocked automated lookups): <strong>call ahead</strong>. Items marked <span class="pill unknown vtag">verify</span> / UNVERIFIED come from cross-references only.
      ${bnotes.length ? `<details><summary class="small muted" style="cursor:pointer">Research notes</summary><ul class="small">${bnotes.map(n => `<li>${h(n)}</li>`).join('')}</ul></details>` : ''}
      <p style="margin:8px 0 0"><a class="btn sm primary" href="#/car/${d.car.id}/shopping">Shopping list →</a></p></div>
    <nav class="part-nav small">${PART_GROUPS.filter(g => groups[g]).map(g => `<a href="#" data-jump="pg-${g.replace(/\W+/g, '-')}">${g} (${groups[g].length})</a>`).join('')}</nav>
    ${PART_GROUPS.filter(g => groups[g]).map(g => `<section class="card" id="pg-${g.replace(/\W+/g, '-')}"><h2>${g}</h2><div class="parts-grid">${groups[g].map(partCard).join('')}</div></section>`).join('')}
    ${toolsSection(pg)}${additivesSection(pg)}
    <p class="small muted">Prices are approximate and change often. Confirm fitment by VIN before buying.</p>`;
  el.onclick = async e => {
    const c = e.target.closest('[data-copy]');
    if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy'; }, 1500); } catch { toast('Copy failed'); } return; }
    const j = e.target.closest('[data-jump]');
    if (j) { e.preventDefault(); document.getElementById(j.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  };
}

// alternates: OEM / first choice, then the good alternate brands (RockAuto first), avoid marked
async function tabAlternates(el, d) {
  const A = await api(`/api/cars/${d.car.id}/alternates`);
  const cp = pn => { const t = String(pn || '').trim(); return t ? `<code>${h(t)}</code><button type="button" class="copy" data-copy="${h(t.split(/\s*[(/]/)[0])}">Copy</button>` : ''; };
  const price = o => o.price_usd != null ? `<strong>$${o.price_usd.toFixed(2)}</strong>` : o.price_text && !/unverif|n\/a|null/i.test(o.price_text) ? `<span>${h(o.price_text)}</span>` : '';
  const srcs = o => o.sources?.length ? `<span class="muted">${o.sources.slice(0, 3).map(u => `<a href="${hu(u)}" target="_blank" rel="noopener noreferrer">${h(hostOf(u))}</a>`).join(' · ')}</span>` : '';
  const row = (o, first) => {
    const tier = TIER[o.tier] || (o.tier ? ['unknown', o.tier] : null);
    return `<li class="alt-row${first ? ' first' : ''}"><div class="alt-main">${first ? `<span class="alt-lbl">${o.is_oem ? 'OEM' : 'First'}</span>` : ''}<strong>${h(o.brand)}</strong> ${cp(o.part_number)}</div>
      <div class="alt-sub small">${tier && !(first && o.is_oem) ? `<span class="pill ${tier[0]} tier">${h(tier[1])}</span>` : ''} ${price(o)} ${o.where ? `<span class="muted">${h(clip(o.where, 60))}</span>` : ''} ${verdictPill(o.verdict)}${o.is_pick ? ' <span class="pill low tier">pick</span>' : ''}${o.verify_fitment ? verifyTag(true, 'Not confirmed for this exact vehicle and engine: check by VIN before buying') : ''} ${srcs(o)}</div></li>`;
  };
  const card = p => `<article class="alt" data-q="${h(`${p.part} ${p.category || ''} ${[p.first_choice, ...p.alternates].filter(Boolean).map(o => `${o.brand} ${o.part_number || ''}`).join(' ')}`.toLowerCase())}">
    <div class="alt-head"><strong>${h(p.part)}</strong><span class="small muted">${h(p.category || '')}</span></div>
    <ul class="alt-list">${p.first_choice ? row(p.first_choice, true) : ''}${p.alternates.map(o => row(o, false)).join('')}</ul>
    ${p.no_alternate ? `<p class="small muted alt-none">No real alternate found.</p>` : ''}${p.note ? `<details class="alt-note small"><summary>Research note</summary>${h(p.note)}</details>` : ''}
    ${p.avoid.length ? `<div class="alt-avoid small"><span class="pill overdue tier">Avoid</span> ${p.avoid.map(a => `<span title="${h(a.why || '')}"><strong>${h(a.brand)}</strong>${a.part_number ? ` ${h(a.part_number)}` : ''}${a.why ? `: ${h(clip(a.why, 110))}` : ''}</span>`).join(' · ')}</div>` : ''}</article>`;
  el.innerHTML = `<div class="alt-top"><input type="search" id="alt-q" placeholder="Filter: oil filter, brakes, WIX…" aria-label="Filter parts">
      <p class="small muted">${A.counts.with_alternates} of ${A.counts.parts} parts have alternates. <strong>OEM</strong> (or the first choice) is listed first, then other good brands, RockAuto first. <span class="pill unknown vtag">verify</span> = not confirmed for this exact engine: check by VIN. Prices are approximate (research date).</p></div>
    <div class="alt-grid">${A.parts.map(card).join('')}</div>
    ${A.spec_only.length ? `<p class="small muted">Spec only, no parts to compare: ${A.spec_only.map(h).join(', ')}.</p>` : ''}`;
  document.getElementById('alt-q').oninput = e => { const q = e.target.value.trim().toLowerCase(); el.querySelectorAll('.alt').forEach(a => a.classList.toggle('hidden', !!q && !a.dataset.q.includes(q))); };
  el.onclick = async e => {
    const c = e.target.closest('[data-copy]');
    if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy'; }, 1500); } catch { toast('Copy failed'); } }
  };
}

function supportPill(v) {
  const t = String(v ?? '').toLowerCase();
  const cls = /^yes|full|supported/.test(t) ? 'ok' : /^no\b|not supported|^none/.test(t) ? 'overdue' : 'soon';
  const full = String(v ?? '?'), short = full.split(/[(,;:.]/)[0].trim().slice(0, 22) || full.slice(0, 22);
  return `<span class="pill ${cls}" title="${h(full)}">${h(short)}</span>${short.length < full.trim().length ? ` <span class="small muted">${h(full.slice(short.length).replace(/^[\s(,;:.]+/, '').replace(/\)$/, ''))}</span>` : ''}`;
}
function toolsSection(pg) {
  const t = pg.scan_tool || pg.topscan || {}, pt = pg.pressure_tester || {};
  if (!Object.keys(t).length && !Object.keys(pt).length) return '';
  const tiers = Array.isArray(t.tiers) ? t.tiers.map(x => `<li><strong>${h(x.tier)}</strong>: ${h(x.includes || [x.services != null ? `${x.services} services` : '', x.renewal ? `renewal ${x.renewal}` : ''].filter(Boolean).join(', '))}</li>`).join('')
    : t.tiers ? Object.entries(t.tiers).map(([k, v]) => `<li><strong>${h(k)}</strong>: ${h(v)}</li>`).join('') : '';
  const mods = (t.modules || []).map(m => typeof m === 'string' ? `<li>${h(m)}</li>` : `<li>${h(m.module || m.name)} ${supportPill(m.supported)}${m.notes ? ` <span class="small muted">${h(m.notes)}</span>` : ''}</li>`).join('');
  const live = (t.live_data || []).map(x => typeof x === 'string' ? `<li>${h(x)}</li>` : `<li><strong>${h(x.pid)}</strong>${x.supported || x.availability ? ` ${supportPill(x.supported || x.availability)}` : ''}${x.why ? ` <span class="small muted">${h(x.why)}</span>` : ''}</li>`).join('');
  const fns = (t.functions || []).map(f => `<tr><td>${h(f.name)}</td><td>${supportPill(f.supported)}</td><td>${h(f.tier || '')}</td><td class="small">${h(f.notes || '')}</td></tr>`).join('');
  return `<section class="card" id="pg-tools"><h2>Tools${t.name ? ` &amp; ${h(t.name)}` : ""}</h2>
    ${t.summary ? `<p>${h(t.summary)}</p>` : ''}
    <div class="grid2"><div>${tiers ? `<h3 class="ki-group">${h(t.name || "Scan tool")} tiers</h3><ul class="small">${tiers}</ul>` : ''}
      ${t.free_without_subscription ? `<h3 class="ki-group">Free (no subscription)</h3><ul class="small">${t.free_without_subscription.map(x => `<li>${h(x)}</li>`).join('')}</ul>` : ''}
      ${t.requires_subscription ? `<h3 class="ki-group">Needs a subscription</h3><ul class="small">${t.requires_subscription.map(x => `<li>${h(x)}</li>`).join('')}</ul>` : ''}</div>
      <div>${mods ? `<h3 class="ki-group">Modules it can reach</h3><ul class="small">${mods}</ul>` : ''}${live ? `<h3 class="ki-group">Useful live data</h3><ul class="small">${live}</ul>` : ''}</div></div>
    ${fns ? `<h3 class="ki-group">Functions</h3><div class="tbl-wrap"><table class="codes"><thead><tr><th>Function</th><th>Works?</th><th>Tier</th><th>Notes</th></tr></thead><tbody>${fns}</tbody></table></div>` : ''}
    ${t.how_to_confirm || t.could_not_confirm ? `<p class="small muted">${h(t.how_to_confirm || t.could_not_confirm)}</p>` : ''}
    ${t.sources?.length ? `<p class="small muted">Sources: ${linkList(t.sources)}</p>` : ''}
    ${Object.keys(pt).length ? `<h3 class="ki-group">Coolant pressure tester${pt.name ? ` (${h(pt.name)})` : ''}</h3>
    <p class="small"><strong>Fits:</strong> ${h(pt.fits || '?')}${pt.fits_detail ? ` <span class="muted">${h(pt.fits_detail)}</span>` : ''}</p>
    ${pt.adapter ? `<p class="small"><strong>Adapter:</strong> ${h(pt.adapter)}</p>` : ''}
    ${pt.price_usd || pt.kit_price_usd ? `<p class="small"><strong>Price:</strong> ${h(pt.price_usd || pt.kit_price_usd)}</p>` : ''}
    ${pt.notes ? `<p class="small">${h(pt.notes)}</p>` : ''}
    <p class="small"><strong>Free alternative:</strong> many US parts stores (e.g. AutoZone, O'Reilly) loan a cooling system pressure tester kit for a refundable deposit. <span class="muted">Check the kit has the right cap adapter for this car.</span></p>
    ${pt.sources?.length ? `<p class="small muted">Sources: ${linkList(pt.sources)}</p>` : ''}` : ''}</section>`;
}
function additivesSection(pg) {
  const list = pg.additives || [];
  if (!list.length) return '';
  const grp = v => /^use/i.test(v) ? 'use' : /^skip/i.test(v) ? 'skip' : 'maybe';
  const label = { use: ['ok', 'Use'], maybe: ['soon', 'Maybe'], skip: ['overdue', 'Skip'] };
  return `<section class="card" id="pg-additives"><h2>Additives</h2>${['use', 'maybe', 'skip'].map(g => { const l = list.filter(a => grp(a.verdict) === g); return l.length ? `<h3 class="ki-group">${pill(label[g][0], label[g][1])}</h3><ul class="list">${l.map(a => `<li><div class="grow"><strong>${h(a.product)}</strong> <span class="small muted">${h(a.use_for || '')}</span>${a.verdict && a.verdict.toLowerCase() !== g ? ` <span class="small">(${h(a.verdict)})</span>` : ''}
      <div class="small">${h(a.why || '')}</div><div class="small muted">${a.how_often ? `How often: ${h(a.how_often)}` : ''}${a.price_usd ? ` · ~$${h(String(a.price_usd).replace(/^\$/, ''))}` : ''}</div>
      ${a.links?.length || a.sources?.length ? `<div class="small muted">${linkList([...(a.links || []), ...(a.sources || [])])}</div>` : ''}</div></li>`).join('')}</ul>` : ''; }).join('')}</section>`;
}

const STOP = new Set(['the', 'and', 'with', 'from', 'that', 'this', 'into', 'after', 'since', 'when', 'engine', 'diagnose', 'diagnosis', 'replace', 'replacement', 'check', 'needed', 'doors', 'moving', 'feels', 'just', 'like']);
const stems = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length > 3 && !STOP.has(w)).map(w => w.slice(0, 5)));
function guidesFor(todo, guides) {
  const a = stems(`${todo.title} ${todo.type === 'symptom' ? todo.notes : ''}`);
  return guides.map((g, i) => ({ g, i, n: [...stems(`${g.title} ${g.related_issue || ''}`)].filter(w => a.has(w)).length })).filter(x => x.n > 0).sort((x, y) => y.n - x.n).slice(0, 3);
}

async function tabGuides(el, d) {
  const { data: pg } = await loadParts(d.car.id);
  if (!pg) { el.innerHTML = '<p class="muted">No guides loaded for this car yet.</p>'; return; }
  const dots = n => `<span class="diff" title="Difficulty ${n}/5">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
  el.innerHTML = `${disclaimerNote('card disclaimer-top')}<p class="small muted">${pg.guides.length} guides for this car. Videos open on YouTube; articles open in a new tab.</p>
    ${pg.guides.map((g, i) => `<details class="item guide" id="guide-${i}"><summary><span>${dots(Number(g.difficulty) || 0)}</span><div><div class="name">${h(g.title)}</div><div class="meta">${g.related_issue ? `For: ${h(g.related_issue)} · ` : ''}${h(g.time || '')}</div></div><span></span></summary>
      <div class="body">
        ${g.tools?.length ? `<p class="small"><strong>Tools:</strong> ${g.tools.map(t => `<span class="chip">${h(t)}</span>`).join('')}</p>` : ''}
        ${g.safety?.length ? `<div class="safety small"><strong>Safety</strong><ul>${g.safety.map(x => `<li>${h(x)}</li>`).join('')}</ul></div>` : ''}
        <ol class="steps">${(g.steps || []).map(x => `<li>${h(typeof x === 'string' ? x : x.step || JSON.stringify(x))}</li>`).join('')}</ol>
        ${g.specs_notes ? `<p class="small muted">${h(g.specs_notes)}</p>` : ''}
        ${g.videos?.length ? `<h4>Videos</h4><ul class="small">${g.videos.map(v => `<li><a href="${hu(v.url)}" target="_blank" rel="noopener noreferrer">${h(v.title)}</a>${v.channel ? ` <span class="muted">· ${h(v.channel)}</span>` : ''}</li>`).join('')}</ul>` : ''}
        ${g.articles?.length ? `<h4>Articles</h4><ul class="small">${g.articles.map(v => `<li><a href="${hu(v.url)}" target="_blank" rel="noopener noreferrer">${h(v.title)}</a></li>`).join('')}</ul>` : ''}
      </div></details>`).join('')}`;
  const want = store.get('garage.guide');
  if (want != null && want !== '') { store.set('garage.guide', ''); const g = document.getElementById(`guide-${want}`); if (g) { g.open = true; g.scrollIntoView({ block: 'start' }); } }
}

function scanCard(s, cars, { inbox = false, car = null } = {}) {
  const when = s.scan_date ? fmtDate(s.scan_date) : fmtTs(s.received_at);
  return `<article class="card" data-id="${s.id}">
    <div class="row" style="align-items:baseline"><h3 style="margin:0;flex:1">${h(when)}${s.mileage ? ` · ${miles(s.mileage)}` : ''}</h3><span class="small muted">${h(s.from_addr || '')}</span></div>
    ${s.vehicle || s.vin ? `<p class="small" style="margin:.3em 0">${s.vehicle ? `Report vehicle: <strong>${h(s.vehicle)}</strong>` : ''}${s.vin ? ` · VIN <code>${h(s.vin)}</code>` : ''}${s.match_how ? ` · <span class="muted">matched by ${h(s.match_how)}</span>` : ''}</p>` : ''}
    ${s.summary ? `<p>${h(s.summary)}</p>` : ''}
    ${s.codes.length ? `<table class="codes"><thead><tr><th>Code</th><th>Description</th><th>Module</th><th>Status</th></tr></thead><tbody>${s.codes.map(k => `<tr><td class="code">${h(k.code)}</td><td>${h(k.description || '')}</td><td>${h(k.module || '')}</td><td>${h(k.status || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No trouble codes found.</p>'}
    ${s.readiness ? `<p class="small"><span class="muted">Readiness:</span> ${h(s.readiness)}</p>` : ''}
    ${s.freeze_frame ? `<p class="small"><span class="muted">Freeze frame:</span> ${h(s.freeze_frame)}</p>` : ''}
    ${s.note ? `<p class="small muted" style="white-space:pre-wrap">${h(s.note)}</p>` : ''}
    <div class="row" style="align-items:center">
      ${s.files.map(f => `<a class="btn sm" href="/api/files/${f.id}" target="_blank" rel="noopener">${h(f.filename)}</a>`).join('')}
      <button class="btn sm ghost" data-act="text">Extracted text</button>
      ${!inbox && s.vin && car && !car.vin ? `<button class="btn sm" data-act="vin">Save VIN to car</button>` : ''}
      <button class="btn sm ghost danger" data-act="del">Delete</button>
    </div>
    ${inbox ? `<form class="row" data-assign style="margin-top:10px;align-items:flex-end"><div class="field" style="margin:0;flex:1"><label>Assign to</label><select name="car_id">${cars.map(c => `<option value="${c.id}">${h(c.nickname)} (${h(ymm(c))})</option>`).join('')}</select></div>
      ${s.vin ? '<label class="check"><input type="checkbox" name="save_vin" checked> Save VIN to that car if it has none</label>' : ''}<button class="btn primary">Assign</button></form>` : ''}
    <pre class="extract hidden"></pre></article>`;
}
function bindScanActions(el, reload, scans) {
  el.onclick = safe(async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const card = b.closest('[data-id]'), id = card.dataset.id;
    if (b.dataset.act === 'text') {
      const pre = card.querySelector('pre.extract');
      if (pre.classList.toggle('hidden')) return;
      pre.textContent = 'Loading…'; pre.textContent = (await api(`/api/scans/${id}/text`)).text || '(no text)';
    }
    if (b.dataset.act === 'vin') { await api(`/api/scans/${id}/save-vin`, { method: 'POST', body: {} }); toast('VIN saved', true); reload(); }
    if (b.dataset.act === 'del') modal('Delete scan?', '<p>Delete this report and its files? To-dos it created stay.</p>', { submit: 'Delete', danger: true, onSubmit: async () => { await api(`/api/scans/${id}`, { method: 'DELETE' }); reload(); } });
  });
  el.onsubmit = safe(async e => {
    if (!e.target.matches('[data-assign]')) return;
    e.preventDefault();
    const id = e.target.closest('[data-id]').dataset.id;
    const f = formData(e.target);
    const r = await api(`/api/scans/${id}/assign`, { method: 'POST', body: f });
    toast(`Assigned${r.todos.length ? `; new to-dos for ${r.todos.join(', ')}` : ''}`, true); refreshInboxBadge(); reload();
  });
}

async function tabScans(el, d, reload) {
  const { address } = await api('/api/senders');
  el.innerHTML = `<div class="section-title" style="margin-top:0"><h2>Scan reports</h2><label class="btn sm primary" for="scan-in">Upload report</label><input id="scan-in" type="file" accept="application/pdf,text/html" class="sr"></div>
    <p class="small muted">${address ? `Email scan-tool reports to <strong>${h(address)}</strong> (from an allowed address in Settings), or upload` : 'Upload'} the PDF or HTML report from your scan tool here.</p>
    <div id="scan-list">${d.scans.length ? d.scans.map(s => scanCard(s, [], { car: d.car })).join('') : '<p class="muted">No scans yet.</p>'}</div>`;
  bindScanActions(document.getElementById('scan-list'), reload, d.scans);
  document.getElementById('scan-in').onchange = safe(async e => {
    const f = e.target.files[0]; if (!f) return;
    toast('Reading the report…', true);
    const r = await api(`/api/cars/${d.car.id}/scans`, { method: 'POST', raw: f });
    toast(`Found ${r.codes.length} code${r.codes.length === 1 ? '' : 's'}`, true); reload();
  });
}

function carForm(c = {}) {
  const color = c.color || '#8a8f98';
  const presets = ['#e9e9e6', '#a9adb3', '#5f6368', '#121316', '#9b1c24', '#5b6f86', '#1f3a5f', '#2f3b2c', '#6b4f2a', '#c8b48a'];
  return `<div class="preview-art" id="car-preview" style="height:200px"></div>
    <div class="row">${field('Name', 'nickname', c.nickname || '', 'text', 'required maxlength="60" placeholder="e.g. The Civic"')}${field('Year', 'year', c.year ?? '', 'number', 'min="1900" max="2100"')}</div>
    <div class="row">${field('Make', 'make', c.make || '')}${field('Model', 'model', c.model || '')}${field('Trim', 'trim', c.trim || '')}</div>
    <div class="row">${field('Engine', 'engine', c.engine || '')}${field('Transmission', 'transmission', c.transmission || '')}</div>
    <div class="row">${field('VIN', 'vin', c.vin || '', 'text', 'maxlength="17" autocapitalize="characters" spellcheck="false"')}${field('Mileage', 'mileage', c.mileage ?? '', 'number', 'min="0" inputmode="numeric"')}</div>
    ${c.id ? '' : '<p class="small"><button type="button" class="btn sm" id="vin-decode">Fill in from the VIN</button> <span class="muted">(NHTSA decoder)</span></p>'}
    <div class="row"><div class="field"><label for="f-body">Body type</label><select id="f-body" name="body_type">${Object.entries(BODY_LABELS).map(([k, l]) => `<option value="${k}" ${k === (c.body_type || 'sedan') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Body color</label><div class="swatches">${presets.map(p => `<button type="button" data-color="${p}" style="background:${p}" aria-label="${p}" class="${p === color ? 'on' : ''}"></button>`).join('')}<input type="color" name="color" value="${h(color)}" aria-label="Custom color"></div></div></div>
    ${area('Notes', 'notes', c.notes || '')}
    ${c.id ? `<div class="field"><label>Your own 3D model <span class="muted small">(optional .glb, up to ${CONFIG.glb_max_mb || 15} MB; replaces the ${h((BODY_LABELS[c.body_type] || 'body style').toLowerCase())} shape)</span></label>
      <div class="row" style="align-items:center"><label class="btn sm" for="glb-in">${c.model_url ? 'Replace .glb' : 'Upload .glb'}</label><input id="glb-in" type="file" accept=".glb,model/gltf-binary" class="sr">${c.model_url ? '<button type="button" class="btn sm danger" id="glb-del">Remove model</button>' : ''}</div>
      <p class="small muted">A binary glTF you made or are allowed to use. Name the body material "paint" to have it take the color above. Draco-compressed files aren't supported.</p></div>` : ''}`;
}
function bindCarForm(form, c = {}) {
  const prev = form.querySelector('#car-preview');
  const colorIn = form.querySelector('[name=color]');
  let pv = null;
  const draw = () => {
    const row = { ...c, ...formData(form) };
    if (pv) { pv.setColor(colorIn.value); return; }
    prev.innerHTML = carSvg(row.body_type, colorIn.value, { label: row.nickname || '' });
  };
  if (HAS_GL) {
    // a small, separate viewer for the colour preview (disposed with the modal)
    pv = new CarViewer(prev, { garage: false });
    pv.init().then(() => { pv.show({ ...c, ...formData(form) }, 0); pv.setColor(colorIn.value); }).catch(() => { pv = null; draw(); });
    const obs = new MutationObserver(() => { if (!document.body.contains(form)) { pv?.dispose(); obs.disconnect(); } });
    obs.observe(document.body, { childList: true });
    form.querySelector('[name=body_type]').onchange = form.querySelector('[name=model]').onchange = form.querySelector('[name=make]').onchange = () => pv?.show({ ...c, ...formData(form) }, 0);
  } else draw();
  colorIn.oninput = () => { form.querySelectorAll('.swatches button').forEach(b => b.classList.remove('on')); draw(); };
  form.querySelector('.swatches').onclick = e => { const b = e.target.closest('[data-color]'); if (!b) return; colorIn.value = b.dataset.color; form.querySelectorAll('.swatches button').forEach(x => x.classList.toggle('on', x === b)); draw(); };
  form.querySelector('[name=body_type]').addEventListener('change', () => { if (!pv) draw(); });
  form.querySelector('#vin-decode')?.addEventListener('click', safe(async () => {
    const vin = form.querySelector('[name=vin]').value.trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new Error('Type the 17-character VIN first');
    const d = await api(`/api/vin/${vin}`);
    for (const k of ['year', 'make', 'model', 'trim', 'engine', 'transmission']) { const el = form.querySelector(`[name=${k}]`); if (el && d[k] && !el.value) el.value = d[k]; }
    if (d.body_type) form.querySelector('[name=body_type]').value = d.body_type;
    const nn = form.querySelector('[name=nickname]'); if (!nn.value && d.model) nn.value = d.model;
    form.querySelector('[name=body_type]').dispatchEvent(new Event('change'));
    toast(d.error ? `Decoded with a warning: ${d.error}` : `Found a ${[d.year, d.make, d.model].filter(Boolean).join(' ')}`, true);
  }));
}
function editCar(c) {
  modal(`Edit ${c.nickname}`, carForm(c) + `<p><button type="button" class="btn sm danger" id="archive">Archive this car</button></p>`, {
    wide: true,
    onOpen: f => {
      bindCarForm(f, c);
      const glb = f.querySelector('#glb-in');
      if (glb) glb.onchange = safe(async e => {
        const file = e.target.files[0]; if (!file) return;
        if (file.size > (CONFIG.glb_max_mb || 15) * 1048576) throw new Error(`That file is over ${CONFIG.glb_max_mb || 15} MB`);
        toast('Uploading the model…', true);
        await api(`/api/cars/${c.id}/model`, { method: 'POST', raw: new File([file], file.name, { type: 'model/gltf-binary' }) });
        toast('Model saved', true); document.querySelector('.modal-back')?.remove(); dropViewer(); render();
      });
      f.querySelector('#glb-del')?.addEventListener('click', safe(async () => { await api(`/api/cars/${c.id}/model`, { method: 'DELETE' }); toast('Model removed', true); document.querySelector('.modal-back')?.remove(); dropViewer(); render(); }));
      f.querySelector('#archive').onclick = safe(async () => { if (!confirm(`Archive ${c.nickname}? It disappears from the garage (data is kept).`)) return; await api(`/api/cars/${c.id}`, { method: 'DELETE' }); document.querySelector('.modal-back')?.remove(); location.hash = '#/'; });
    },
    onSubmit: async f => { await api(`/api/cars/${c.id}`, { method: 'PATCH', body: f }); toast('Saved', true); dropViewer(); render(); },
  });
}
async function viewNewCar(seq) {
  dropViewer();
  app.innerHTML = `<div class="card" style="max-width:760px;margin:0 auto"><h1>Add a car</h1><form id="new-car">${carForm({})}
    <label class="check"><input type="checkbox" name="default_schedule" checked> Start with a typical maintenance schedule (oil, tires, filters, fluids…)</label>
    <div class="modal-actions"><a class="btn ghost" href="#/">Cancel</a><button class="btn primary">Add car</button></div></form></div>`;
  const form = document.getElementById('new-car');
  bindCarForm(form, {});
  form.onsubmit = safe(async e => {
    e.preventDefault();
    const { id } = await api('/api/cars', { method: 'POST', body: formData(form) });
    store.set('garage.car', id); location.hash = `#/car/${id}/maintenance`;
  });
}

// ---------------------------------------------------------------- due list
async function viewDue(seq) {
  const d = await api('/api/due?all=1');
  if (stale(seq)) return;
  document.title = 'Due list · ' + CONFIG.app_name;
  const overdue = d.items.filter(i => i.status === 'overdue'), soon = d.items.filter(i => i.status === 'soon'), unknown = d.items.filter(i => i.status === 'unknown');
  const line = (i, cls) => `<a class="due-line ${cls}" href="#/car/${i.car_id}/${i.item_id ? 'maintenance' : 'todo'}"><span class="car">${h(i.car)}</span><span class="what">${h(i.name || i.title)}${i.type === 'symptom' ? ' <span class="chip symptom-chip">symptom</span>' : ''}${i.dtc_code ? ` <span class="chip">${h(i.dtc_code)}</span>` : ''}</span><span class="when">${h(i.label || i.priority)}</span></a>`;
  const asText = () => {
    const L = [`Garage due list (${d.today})`];
    if (overdue.length) L.push('', 'OVERDUE / DUE NOW', ...overdue.map(i => `- ${i.car}: ${i.name} (${i.label})`));
    if (soon.length) L.push('', 'DUE SOON', ...soon.map(i => `- ${i.car}: ${i.name} (${i.label})`));
    if (d.todos.length) L.push('', 'OPEN TO-DOS', ...d.todos.map(t => `- [${t.priority}] ${t.car}: ${t.title}`));
    return L.join('\n');
  };
  app.innerHTML = `<div class="symptom-bar">${symptomBtn('')}</div><div class="section-title" style="margin-top:0"><h1 style="margin:0">What needs doing</h1><button class="btn sm" id="copy">Copy as text</button></div>
    <p class="muted small">${fmtDate(d.today)} · ${d.counts.overdue} overdue · ${d.counts.soon} due soon · ${d.counts.open_todos} open to-dos</p>
    ${!overdue.length && !soon.length && !d.todos.length ? '<div class="card big-check">All caught up. Nothing due.</div>' : ''}
    ${overdue.length ? `<section class="due-group"><h2>${pill('overdue', 'Overdue / due now')}</h2>${overdue.map(i => line(i, 'overdue')).join('')}</section>` : ''}
    ${soon.length ? `<section class="due-group"><h2>${pill('soon', 'Due soon')}</h2>${soon.map(i => line(i, 'soon')).join('')}</section>` : ''}
    ${d.todos.length ? `<section class="due-group"><h2>Open to-dos</h2>${d.todos.map(t => line({ ...t, label: t.priority }, `todo-${t.priority}`)).join('')}</section>` : ''}
    ${unknown.length ? `<details class="due-group"><summary class="muted" style="cursor:pointer">${unknown.length} items with no last-done date (not tracked until set)</summary><div style="margin-top:8px">${unknown.map(i => line(i, 'unknown')).join('')}</div></details>` : ''}`;
  document.getElementById('copy').onclick = safe(async () => { await navigator.clipboard.writeText(asText()); toast('Copied', true); });
}

// ---------------------------------------------------------------- inbox
async function viewInbox(seq) {
  const [{ scans }, { cars }] = await Promise.all([api('/api/scans?unmatched=1'), api('/api/cars')]);
  if (stale(seq)) return;
  document.title = 'Inbox · ' + CONFIG.app_name;
  app.innerHTML = `<h1>Unmatched scans</h1><p class="muted small">Reports that couldn't be matched to a car by VIN or year/make/model land here.</p>
    <div id="inbox">${scans.length ? scans.map(s => scanCard(s, cars, { inbox: true })).join('') : '<div class="card big-check">Inbox empty.</div>'}</div>`;
  bindScanActions(document.getElementById('inbox'), render, scans);
}

// ---------------------------------------------------------------- settings
const MODE_LABEL = { password: 'Household password', none: 'No sign-in', 'cloudflare-access': 'Cloudflare Access', oidc: 'Single sign-on (OIDC)' };
async function viewSettings(seq) {
  const memberMode = ['oidc', 'cloudflare-access'].includes(CONFIG.auth_mode);
  const [{ members }, senders, { cars }, { grants }, queue, notes] = await Promise.all([
    memberMode ? api('/api/members') : { members: [] },
    hasInt('email') ? api('/api/senders') : { senders: [], address: null },
    api('/api/cars'), api('/api/connections').catch(() => ({ grants: [] })),
    api('/api/research/queue').catch(() => ({ queue: [] })),
    api('/api/notifications').catch(() => ({ notifications: [] })),
  ]);
  if (stale(seq)) return;
  document.title = `Settings · ${CONFIG.app_name}`;
  const owner = ME?.is_owner;
  const mcp = `${CONFIG.origin}/mcp`;
  const pushOk = 'serviceWorker' in navigator && 'PushManager' in window;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  app.innerHTML = `<h1>Settings</h1><div class="grid2">
    <section class="card"><h2>Sign-in</h2><p class="small"><strong>${h(MODE_LABEL[CONFIG.auth_mode] || CONFIG.auth_mode)}</strong>.
      ${CONFIG.auth_mode === 'password' ? 'Everyone in the house uses the same password; the name typed at sign-in shows who logged what. Change the password from the kit folder with <code>npm run set-password</code>.' : ''}
      ${CONFIG.auth_mode === 'none' ? '<strong class="warn-text">Anyone who knows this address can see and change everything.</strong> Switch to the household password: tell Claude Code "turn on a password for my garage".' : ''}
      ${CONFIG.auth_mode === 'cloudflare-access' ? 'Cloudflare Access decides who gets in (Zero Trust → Access → Applications). Everyone it lets in is a member here.' : ''}
      ${CONFIG.auth_mode === 'oidc' ? 'People sign in with your identity provider; only the members below get in.' : ''}</p>
      ${memberMode ? `<ul class="list">${members.map(m => `<li><div class="grow"><strong>${h(m.name || m.email)}</strong><div class="small muted">${h(m.email)} · ${m.is_owner ? 'owner' : 'member'} · ${m.linked ? 'signed in before' : 'not signed in yet'}</div></div>${owner && m.id !== ME.id ? `<button class="btn sm danger" data-del-member="${m.id}">Remove</button>` : ''}</li>`).join('')}</ul>
      ${owner && CONFIG.auth_mode === 'oidc' ? `<form id="add-member" class="row" style="align-items:flex-end">${field('Email', 'email', '', 'email', 'required')}${field('Name', 'name')}<button class="btn primary">Add</button></form><p class="small muted">A new member is matched by email the first time they sign in.</p>` : ''}` : ''}
    </section>
    <section class="card"><h2>Cars</h2><ul class="list">${cars.map(c => `<li><div class="grow"><strong>${h(c.nickname)}</strong><div class="small muted">${h(ymm(c))}${c.vin ? ` · ${h(c.vin)}` : ' · no VIN yet'}</div></div><a class="btn sm" href="#/car/${c.id}/overview">Open</a></li>`).join('') || '<li class="muted small">No cars yet.</li>'}</ul>
      <a class="btn primary" href="#/new-car">Add a car</a><p class="small muted">Or in Claude Code, in the kit folder: "add a car".</p></section>
    <section class="card"><h2>Connect your Claude</h2>
      <p class="small">Let Claude read the garage and add symptoms, to-dos, services, receipts and research for you. Server URL: <code>${h(mcp)}</code>. You'll sign in here and click Allow.</p>
      <ol class="small" style="padding-left:1.2em">
        <li><strong>claude.ai</strong> (web, and the phone apps pick it up): Settings → Connectors → <em>Add custom connector</em> → name "${h(CONFIG.app_name)}", URL <code>${h(mcp)}</code> → Add → Connect.</li>
        <li><strong>Claude Desktop</strong>: Settings → Connectors → <em>Add custom connector</em> → same URL.</li>
        <li><strong>Claude Code</strong>: <code>claude mcp add --transport http garage ${h(mcp)}</code>, then <code>/mcp</code> → <em>Authenticate</em>.</li>
      </ol>
      <h3 style="font-size:1rem">Connected Claude apps</h3>
      <ul class="list">${grants.length ? grants.map(g => `<li><div class="grow">${h(g.client)} <span class="small muted">· since ${fmtTs(g.created_at)}</span></div><button class="btn sm danger" data-revoke="${h(g.id)}">Disconnect</button></li>`).join('') : '<li class="muted small">None yet.</li>'}</ul>
    </section>
    <section class="card"><h2>Research</h2>
      <p class="small">${CONFIG.research_worker ? 'Your research computer checks for new symptoms every 5 minutes and researches them with your Claude Code.' : 'New symptoms wait here until a Claude researches them: in Claude Code say "research the waiting symptoms", or ask a Claude app with this garage connected. (A computer that is always on can do it automatically: ask Claude Code to "set up automatic research".)'}</p>
      <ul class="list">${queue.queue.length ? queue.queue.map(q => `<li><div class="grow"><strong>${h(q.title)}</strong><div class="small muted">${h(q.car)} · ${q.status} since ${fmtTs(Date.parse(q.queued_at) / 1000)}</div></div><a class="btn sm" href="#/car/${q.car_id}/todo">Open</a></li>`).join('') : '<li class="muted small">Nothing waiting.</li>'}</ul></section>
    <section class="card"><h2>Notifications</h2>
      ${hasInt('push') ? `<p class="small">Reminders for due maintenance, the monthly mileage check, research results and emailed receipts, on this device.</p>
        ${!pushOk ? '<p class="small muted">This browser can\'t do push notifications.</p>' : ios && !standalone ? '<p class="small"><strong>On iPhone/iPad:</strong> first add this app to your Home Screen (Share → Add to Home Screen), open it from there, then turn notifications on.</p>' : `<p class="row"><button class="btn primary" id="push-on">Turn on for this device</button><button class="btn" id="push-test">Send a test</button><button class="btn" id="push-off">Turn off</button></p>`}`
      : `<p class="small muted">${hasInt('home_assistant') || hasInt('email') ? `Sent through ${[hasInt('home_assistant') && 'Home Assistant', hasInt('email') && 'email'].filter(Boolean).join(' and ')}.` : 'No notification integration is on. Ask Claude Code to "turn on notifications for my garage" (web push works on phones, including iPhone home-screen apps).'}</p>${hasInt('home_assistant') || hasInt('email') ? '<p><button class="btn" id="push-test">Send a test</button></p>' : ''}`}
      ${notes.notifications.length ? `<h3 style="font-size:1rem">Recent</h3><ul class="list small">${notes.notifications.slice(0, 6).map(n => `<li><div class="grow"><strong>${h(n.title)}</strong><div class="muted">${h(n.body || '')}</div></div><span class="muted">${fmtTs(n.at)}</span></li>`).join('')}</ul>` : ''}
    </section>
    ${hasInt('email') ? `<section class="card"><h2>Email-in</h2><p class="small">Send scan-tool reports <strong>and receipts</strong> (photos, PDFs, forwarded shop or parts-order emails) to <strong>${h(senders.address)}</strong>. Receipts wait under "receipts to check" until you save them. Only these senders are accepted:</p>
      <ul class="list">${senders.senders.map(s => `<li><div class="grow">${h(s.email)}${s.note ? ` <span class="small muted">· ${h(s.note)}</span>` : ''}</div><button class="btn sm danger" data-del-sender="${h(s.email)}">Remove</button></li>`).join('') || '<li class="muted small">Nobody yet: add your own address.</li>'}</ul>
      <form id="add-sender" class="row" style="align-items:flex-end">${field('Allow sender', 'email', '', 'email', 'required')}${field('Note', 'note')}<button class="btn primary">Add</button></form>
    </section>` : ''}
    <section class="card"><h2>Credits</h2><ul class="small" style="margin:0;padding-left:1.2em">
      <li>3D cars: procedural body styles built for this app; or your own uploaded .glb.</li>
      <li>Rendered with <a href="https://threejs.org" rel="noopener" target="_blank">three.js</a> (MIT, incl. its GLTFLoader and BufferGeometryUtils) and the meshoptimizer decoder (MIT).</li>
      <li>Email parsing: postal-mime (MIT-0). MCP sign-in: @cloudflare/workers-oauth-provider (MIT). Vehicle decoding and recalls: NHTSA vPIC (public API).</li></ul></section>
    <section class="card"><h2>About</h2><p class="small">Garage kit${CONFIG.version ? ` <strong>v${h(CONFIG.version)}</strong>` : ''}, running on ${CONFIG.runtime === 'docker' ? 'Docker' : 'Cloudflare Workers'}. AI: ${CONFIG.ai === false ? 'turned off' : 'on'}.
      <a href="https://github.com/Taylorshome/garage-kit/blob/main/CHANGELOG.md" rel="noopener" target="_blank">What's new</a></p></section>
    <section class="card"><h2>Account</h2><p>${CONFIG.auth_mode === 'none' ? 'No sign-in is set up.' : `Signed in as <strong>${h(ME?.name)}</strong>${ME?.email ? ` (${h(ME.email)})` : ''}.`}</p>
      ${CONFIG.auth_mode === 'none' ? '' : '<form method="post" action="/auth/logout"><button class="btn">Sign out</button></form>'}</section>
  </div>`;
  const reload = () => render();
  document.getElementById('add-member')?.addEventListener('submit', safe(async e => { e.preventDefault(); await api('/api/members', { method: 'POST', body: formData(e.target) }); toast('Member added', true); reload(); }));
  document.getElementById('add-sender')?.addEventListener('submit', safe(async e => { e.preventDefault(); await api('/api/senders', { method: 'POST', body: formData(e.target) }); toast('Sender allowed', true); reload(); }));
  document.getElementById('push-on')?.addEventListener('click', safe(async () => { await pushSubscribe(); toast('Notifications on for this device', true); }));
  document.getElementById('push-off')?.addEventListener('click', safe(async () => { await pushUnsubscribe(); toast('Notifications off for this device', true); }));
  document.getElementById('push-test')?.addEventListener('click', safe(async () => { const r = await api('/api/push/test', { method: 'POST', body: {} }); toast(r.channels?.push?.sent === 0 ? 'No device is subscribed yet' : 'Test sent', true); }));
  app.onclick = safe(async e => {
    const g = e.target.closest('[data-revoke]');
    if (g) { await api(`/api/connections/${g.dataset.revoke}`, { method: 'DELETE' }); toast('Disconnected', true); return reload(); }
    const m = e.target.closest('[data-del-member]'), s = e.target.closest('[data-del-sender]');
    if (m) { await api(`/api/members/${m.dataset.delMember}`, { method: 'DELETE' }); reload(); }
    if (s) { await api(`/api/senders/${encodeURIComponent(s.dataset.delSender)}`, { method: 'DELETE' }); reload(); }
  });
}

// ---------------------------------------------------------------- web push (payload-less; public/sw.js fetches the text)
const b64uToBytes = v => { const p = v.replace(/-/g, '+').replace(/_/g, '/'); const s = atob(p + '='.repeat((4 - (p.length % 4)) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); };
async function pushSubscribe() {
  if (!CONFIG.vapid_public_key) throw new Error('Push is not set up on the server (VAPID key missing)');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed');
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(CONFIG.vapid_public_key) });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
}
async function pushUnsubscribe() {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
}

// ---------------------------------------------------------------- guided diagnosis
// #/diagnose/<car>[/<todo>] pick a plan (or describe the symptom; no plan -> offer an AI plan)
// #/diag/<session>          one step at a time: safety first, big answer buttons, skip, change an answer, finish
const DIAG_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21M8 10.5h5M10.5 8v5"/></svg>';
const diagHref = (carId, todoId = '') => `#/diagnose/${carId}${todoId ? `/${todoId}` : ''}`;
const diagBtn = (carId, todoId = '', label = 'Diagnose', cls = '') => `<a class="btn ${cls}" href="${diagHref(carId, todoId)}">${DIAG_ICON} ${h(label)}</a>`;
const STANDING_PILL = { confirmed: ['overdue', 'confirmed'], leading: ['soon', 'leading'], possible: ['unknown', 'possible'], unlikely: ['ok', 'unlikely'] };
const DIAG_STATUS = { active: ['soon', 'in progress'], found: ['ok', 'found'], inconclusive: ['unknown', 'inconclusive'], abandoned: ['unknown', 'stopped'] };
let DIAG = { id: null, last: null, force: null };

function activeDiagHtml(list) {
  const act = (list || []).filter(s => s.status === 'active');
  if (!act.length) return '';
  return `<section class="card dg-active"><h2>${DIAG_ICON} Diagnosis in progress</h2>${act.map(s => `<a class="pick" href="#/diag/${s.session_id}"><span class="grow"><strong>${h(s.plan)}</strong>
    <span class="small muted">${s.answered} of ${s.total} checks · ${h(s.updated)}${s.started_by ? ` · ${h(s.started_by)}` : ''}${s.source === 'ai' ? ' · AI plan' : ''}</span></span><span class="pick-go" aria-hidden="true">›</span></a>`).join('')}</section>`;
}
const todoLooksLikeSymptom = (t, plans) => !String(t.source || '').startsWith('diagnosis:') && (t.type === 'symptom' || plans.some(p => (p.todo_match || []).some(w => `${t.title} ${t.notes || ''}`.toLowerCase().includes(String(w).toLowerCase()))));

async function viewDiagnoseStart(seq, carId, todoId = '') {
  dropViewer();
  const [d, todo] = await Promise.all([api(`/api/cars/${carId}/diagnoses`), todoId ? api(`/api/todos/${todoId}`).catch(() => null) : null]);
  if (stale(seq)) return;
  const t = todo?.todo || todo;
  document.title = `Diagnose · ${d.car.nickname} · Garage`;
  const text = t ? `${t.title} ${t.notes || ''}`.toLowerCase() : '';
  const suggested = t ? d.plans.filter(p => (p.todo_match || []).some(w => text.includes(String(w).toLowerCase()))) : [];
  const plans = [...suggested, ...d.plans.filter(p => !suggested.includes(p))];
  const planBtn = p => `<button type="button" class="pick" data-plan="${h(p.id)}"><span class="grow"><strong>${h(p.title)}</strong><span class="small muted">${p.steps} checks${p.source === 'ai' ? ' · AI-generated, check before trusting' : ' · from the research'}${suggested.includes(p) ? ' · suggested' : ''}</span></span><span class="pick-go" aria-hidden="true">›</span></button>`;
  app.innerHTML = `<div class="car-head"><a class="btn ghost sm" href="#/car/${carId}/${todoId ? 'todo' : 'overview'}">‹ ${h(d.car.nickname)}</a><div><h1>Diagnose</h1><div class="ymm">${h([d.car.year, d.car.make, d.car.model].join(' '))}</div></div></div>
    ${activeDiagHtml(d.sessions)}
    ${t ? `<p class="small muted">For: <strong>${h(t.title)}</strong></p>` : ''}
    <section class="card"><h2>What's wrong?</h2><p class="small muted">Step-by-step checks, cheapest and most likely first, one at a time.</p>
      <div class="pick-list">${plans.length ? plans.map(planBtn).join('') : '<p class="muted">No ready-made plans for this car yet.</p>'}</div></section>
    <section class="card"><h2>Something else</h2>
      <form id="dg-free" novalidate><div class="field"><label for="dg-sym">Describe it</label><textarea id="dg-sym" name="symptom" rows="2" maxlength="300" placeholder="e.g. squeal when it starts cold">${t && !suggested.length ? h(t.title) : ''}</textarea></div>
      <button class="btn primary" type="submit">Find checks</button></form><div id="dg-gen"></div></section>`;
  const start = async body => {
    const r = await api(`/api/cars/${carId}/diagnoses`, { method: 'POST', body: { ...body, todo_id: todoId || undefined } });
    if (r.needs_plan) return r;
    DIAG = { id: r.session_id, last: null, force: null };
    location.hash = `#/diag/${r.session_id}`;
    return r;
  };
  app.querySelector('.pick-list').onclick = safe(async e => { const b = e.target.closest('[data-plan]'); if (b) { b.disabled = true; await start({ plan_id: b.dataset.plan }); } });
  document.getElementById('dg-free').onsubmit = safe(async e => {
    e.preventDefault();
    const symptom = document.getElementById('dg-sym').value.trim();
    if (!symptom) { toast('Describe what it does first'); return; }
    const r = await start({ symptom });
    if (!r?.needs_plan) return;
    const box = document.getElementById('dg-gen');
    box.innerHTML = `<div class="dg-warn card"><p><strong>No ready-made plan for that.</strong> The garage AI can write one from the ${h(d.car.nickname)}'s research. It takes 1-3 minutes and is marked <em>AI-generated, check before trusting</em>.</p>
      ${r.close_matches.length ? `<p class="small">Close: ${r.close_matches.map(m => `<a href="#" data-plan-near="${h(m.plan_id)}">${h(m.title)}</a>`).join(' · ')}</p>` : ''}
      <button class="btn primary" id="dg-generate">Generate a plan</button></div>`;
    box.onclick = safe(async ev => {
      const near = ev.target.closest('[data-plan-near]');
      if (near) { ev.preventDefault(); await start({ plan_id: near.dataset.planNear }); return; }
      if (ev.target.id !== 'dg-generate') return;
      ev.target.disabled = true; ev.target.innerHTML = '<span class="spinner" aria-hidden="true"></span> Writing the plan… (1-3 min)';
      try { await start({ symptom, generate: true }); } finally { if (document.body.contains(ev.target)) { ev.target.disabled = false; ev.target.textContent = 'Generate a plan'; } }
    });
  });
}

function diagStepCard(s, v, { forced = false } = {}) {
  const cur = v.results?.[s.id];
  return `<section class="card dg-step" id="dg-step" data-step="${h(s.id)}">
    <div class="dg-num">Step ${s.number} of ${s.of}${s.minutes ? ` · ~${s.minutes} min` : ''}${forced ? (cur ? ' · changing your answer' : ' · skipped earlier') : ''}</div>
    <h2>${h(s.title)}</h2>
    ${s.safety?.length ? `<div class="dg-safety" role="note"><strong>Safety first</strong><ul>${s.safety.map(x => `<li>${h(x)}</li>`).join('')}</ul></div>` : ''}
    <p class="dg-do">${h(s.do)}</p>
    <p class="dg-look"><span class="muted">Look for:</span> ${h(s.look_for)}</p>
    ${s.tools?.length ? `<div>${s.tools.map(x => `<span class="chip">${h(x)}</span>`).join('')}</div>` : ''}
    <div class="dg-opts" role="group" aria-label="What did you find?">${s.options.map(o => `<button type="button" class="dg-opt${cur?.result === o.key ? ' on' : ''}${o.key === 'unsure' ? ' unsure' : ''}" data-opt="${h(o.key)}">${h(o.label)}</button>`).join('')}</div>
    <details class="dg-more"${cur?.notes ? ' open' : ''}><summary>Add a note, mileage or photo</summary>
      <div class="field"><label for="dg-notes">Note</label><textarea id="dg-notes" rows="2" maxlength="2000" placeholder="What you saw, readings, where">${h(cur?.notes || '')}</textarea></div>
      <div class="row ql-2"><div class="field"><label for="dg-miles">Odometer</label><input id="dg-miles" type="number" inputmode="numeric" min="0" value="${cur?.mileage ?? ''}"></div>
        <div class="field"><label for="dg-photo">Photo</label><input id="dg-photo" type="file" accept="image/*" capture="environment"></div></div></details>
    <div class="row dg-actions"><button type="button" class="btn ghost sm" data-skip="${h(s.id)}">Can't do that now</button>${forced ? '<button type="button" class="btn ghost sm" data-unforce>Back to the current step</button>' : ''}</div>
    ${s.sources?.length ? `<div class="small muted dg-src">Sources: ${srcLinks(s.sources).replace(/^<div class="small">|<\/div>$/g, '')}</div>` : ''}
  </section>`;
}

async function viewDiag(seq, id) {
  dropViewer();
  const v = await api(`/api/diagnoses/${id}`);
  if (stale(seq)) return;
  if (DIAG.id !== id) DIAG = { id, last: null, force: null };
  document.title = `${v.plan.title} · Garage`;
  const active = v.status === 'active';
  const pct = Math.round(((v.progress.answered + v.progress.skipped) / v.progress.total) * 100);
  const force = active && DIAG.force ? v.steps.find(s => s.id === DIAG.force) : null;
  const stepFull = force || (active && v.step ? v.steps.find(s => s.id === v.step.id) : null);
  const last = DIAG.last;
  const photosOf = stepId => v.photos.filter(p => p.diag_step === stepId);
  const lastHtml = last ? `<section class="card dg-last${last.stop ? ' stop' : ''}" role="status"><div class="dg-num">${h(last.step_title)}</div><p><strong>${h(last.answer)}</strong>: ${h(last.means)}</p>
      ${last.confirmed?.length ? `<p class="small"><span class="muted">Confirmed:</span> ${h(last.confirmed.join('; '))}</p>` : ''}${last.ruled_out?.length ? `<p class="small"><span class="muted">Ruled out:</span> ${h(last.ruled_out.join('; '))}</p>` : ''}
      ${last.more_likely?.length ? `<p class="small"><span class="muted">More likely now:</span> ${h(last.more_likely.join('; '))}</p>` : ''}${last.less_likely?.length ? `<p class="small"><span class="muted">Less likely now:</span> ${h(last.less_likely.join('; '))}</p>` : ''}
      ${last.stop ? `<p class="dg-stop"><strong>Stop:</strong> ${h(last.stop)}</p>` : ''}</section>` : '';
  let main = '';
  if (!active) {
    const st = DIAG_STATUS[v.status] || DIAG_STATUS.inconclusive;
    main = `<section class="card dg-done"><div class="row" style="align-items:center;gap:8px"><h2 style="margin:0">Result</h2>${pill(st[0], st[1])}${v.confidence ? `<span class="small muted">${h(v.confidence)} confidence</span>` : ''}</div>
      <p class="dg-concl">${h(v.conclusion || '')}</p><pre class="dg-summary">${h(v.summary || '')}</pre>
      <div class="row"><a class="btn sm" href="#/car/${v.car_id}/history">History ›</a>${v.fix_todo_id ? `<a class="btn sm" href="#/car/${v.car_id}/todo">Fix to-do ›</a>` : v.found ? '<button class="btn sm primary" id="dg-fixtodo">Add the fix to-do</button>' : ''}</div></section>`;
  } else if (stepFull) main = diagStepCard(stepFull, v, { forced: !!force });
  else if (v.found) main = `<section class="card dg-found"><div class="dg-num">Found it · ${h(v.found.confidence)} confidence</div><h2>${h(v.found.cause)}</h2>
      ${v.found.fix ? `<p><span class="muted">Fix:</span> ${h(v.found.fix)}</p>` : ''}${v.found.cost ? `<p><span class="muted">Cost:</span> ${h(v.found.cost)}</p>` : ''}
      <p class="small muted">From "${h(v.found.at_step || '')}". If that's not right, change an answer below.</p><button class="btn primary" data-finish>Finish and save</button></section>`;
  else main = `<section class="card dg-found"><h2>${v.skipped_steps.length ? 'Only skipped checks left' : 'All checks done'}</h2>
      <p>${v.skipped_steps.length ? `Skipped: ${h(v.skipped_steps.map(x => x.title).join('; '))}. Do one now from the list below, or finish.` : 'Nothing pinned it down. The causes still in play are below.'}</p><button class="btn primary" data-finish>Finish and save</button></section>`;
  const causes = `<section class="card"><h2>What it could be</h2><ul class="list">${v.likely_causes.map(c => { const p = STANDING_PILL[c.standing] || STANDING_PILL.possible; return `<li><div class="grow">${h(c.cause)}</div>${pill(p[0], p[1])}</li>`; }).join('') || '<li class="muted">Nothing left in play.</li>'}</ul>
    ${v.ruled_out.length ? `<p class="small muted dg-ruled">Ruled out: ${v.ruled_out.map(x => `<s>${h(x)}</s>`).join(' · ')}</p>` : ''}</section>`;
  const answers = v.history.length ? `<section class="card"><h2>Your answers</h2><ul class="list dg-answers">${v.history.map(a => `<li><div class="grow"><span class="small muted">${a.number}.</span> <strong>${h(a.title)}</strong>
      <div class="small">${a.result === 'skipped' ? '<span class="pill unknown">skipped</span>' : h(a.result)}${a.notes ? ` <span class="muted">· ${h(a.notes)}</span>` : ''}${a.mileage ? ` <span class="muted">· ${miles(a.mileage)}</span>` : ''}${a.ignored ? ' <span class="muted">(after the finding; not counted)</span>' : ''}</div>
      ${photosOf(a.step).length ? `<div class="thumbs">${photosOf(a.step).map(f => `<a href="/api/files/${f.id}" target="_blank" rel="noopener">${/hei[cf]/.test(f.content_type) ? `<span class="doc">${h(f.filename)}</span>` : `<img src="/api/files/${f.id}" alt="${h(f.filename)}" loading="lazy">`}</a>`).join('')}</div>` : ''}</div>
      ${active ? `<button class="btn sm ghost" data-change="${h(a.step)}">${a.result === 'skipped' ? 'Do it now' : 'Change'}</button>` : ''}</li>`).join('')}</ul></section>` : '';
  app.innerHTML = `<div class="car-head"><a class="btn ghost sm" href="#/car/${v.car_id}/overview">‹ ${h(v.car)}</a><div><h1>${h(v.plan.title)}</h1>
      <div class="ymm small">${h(v.progress.text)} · ${h(v.started)}${v.started_by ? ` · ${h(v.started_by)}` : ''}</div></div></div>
    ${disclaimerNote('card disclaimer-top')}
    ${v.plan.warning ? `<div class="card dg-warn"><strong>AI-generated plan, check before trusting.</strong> It was written by the garage AI from the car's research, not hand-checked.</div>` : ''}
    <div class="dg-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    ${active && !v.history.length && !last && (v.intro || v.safety_overview) ? `<section class="card dg-intro">${v.intro ? `<p>${h(v.intro)}</p>` : ''}${v.safety_overview ? `<div class="dg-safety" role="note"><strong>Safety for this whole job</strong><p>${h(v.safety_overview)}</p></div>` : ''}</section>` : ''}
    ${lastHtml}${main}${active ? causes : ''}${answers}${!active ? causes : ''}
    ${active ? `<div class="cu-bar dg-bar"><span class="small muted">${h(v.progress.text)}</span><button class="btn" data-finish>Finish</button></div>` : ''}`;
  if (force || last) document.querySelector(force ? '#dg-step' : '.dg-last')?.scrollIntoView({ block: 'start' });
  const answer = async (stepId, key) => {
    const notes = document.getElementById('dg-notes')?.value.trim(), mi = document.getElementById('dg-miles')?.value, ph = document.getElementById('dg-photo')?.files?.[0];
    if (ph) await api(`/api/diagnoses/${id}/photos?step=${encodeURIComponent(stepId)}`, { method: 'POST', raw: await shrinkPhoto(ph).catch(() => ph) });
    const r = await api(`/api/diagnoses/${id}/result`, { method: 'POST', body: { step: stepId, result: key, notes: notes || undefined, mileage: mi || undefined } });
    DIAG = { id, last: r.last_result, force: null };
    render();
  };
  const finish = () => {
    const st = v.found ? 'found' : v.history.some(a => a.result !== 'skipped') ? 'inconclusive' : 'abandoned';
    modal('Finish this diagnosis?', `<div class="field"><label for="dg-st">Result</label><select id="dg-st" name="status">${[['found', 'Found the cause'], ['inconclusive', 'Not pinned down'], ['abandoned', 'Stopping here']].map(([k, l]) => `<option value="${k}" ${k === st ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="dg-con">Conclusion (optional)</label><textarea id="dg-con" name="conclusion" rows="2" maxlength="1000" placeholder="${h(v.found?.cause || 'In your words')}"></textarea></div>
      <p class="small muted">A summary goes in the ${h(v.car)}'s History, and a note on related to-dos (they stay open).</p>`, {
      submit: 'Finish and save',
      onSubmit: async f => {
        const r = await api(`/api/diagnoses/${id}/finish`, { method: 'POST', body: { status: f.status, conclusion: f.conclusion || undefined } });
        DIAG = { id, last: null, force: null };
        toast('Saved to History', true);
        if (r.fix_todo_proposal) setTimeout(() => offerFixTodo(id, r.fix_todo_proposal), 50); else render();
      },
    });
  };
  app.onclick = safe(async e => {
    const o = e.target.closest('[data-opt]');
    if (o) { const card = o.closest('[data-step]'); app.querySelectorAll('.dg-opt').forEach(b => { b.disabled = true; }); o.classList.add('busy'); try { await answer(card.dataset.step, o.dataset.opt); } finally { app.querySelectorAll('.dg-opt').forEach(b => { b.disabled = false; }); } return; }
    const sk = e.target.closest('[data-skip]');
    if (sk) { const r = await api(`/api/diagnoses/${id}/skip`, { method: 'POST', body: { step: sk.dataset.skip } }); DIAG = { id, last: r.last_result, force: null }; return render(); }
    const ch = e.target.closest('[data-change]');
    if (ch) { DIAG = { id, last: null, force: ch.dataset.change }; return render(); }
    if (e.target.closest('[data-unforce]')) { DIAG = { id, last: null, force: null }; return render(); }
    if (e.target.closest('[data-finish]')) return finish();
    if (e.target.id === 'dg-fixtodo') { const r = await api(`/api/diagnoses/${id}/finish`, { method: 'POST', body: {} }); if (r.fix_todo_proposal) offerFixTodo(id, r.fix_todo_proposal); }
  });
}

function offerFixTodo(id, p) {
  modal('Add a to-do for the fix?', `<p><strong>${h(p.title)}</strong></p>${p.parts?.length ? `<p class="small muted">Parts</p><ul class="small">${p.parts.map(x => `<li>${h(x.part)}${x.numbers?.length ? `: ${h(x.numbers.join(', '))}` : ''}</li>`).join('')}</ul>` : ''}
    ${p.related_todos?.length ? `<p class="small muted">Related: ${h(p.related_todos.map(t => t.title).join('; '))} (left open)</p>` : ''}`, {
    submit: 'Add to-do',
    onSubmit: async () => { await api(`/api/diagnoses/${id}/finish`, { method: 'POST', body: { create_fix_todo: true } }); toast('Fix to-do added', true); render(); },
  });
  document.querySelector('.modal-back [data-close]')?.addEventListener('click', () => render(), { once: true });
}

// ---------------------------------------------------------------- garage door intro
// A sectional roll-up door over the garage-select scene, once per session. It lifts when the 3D scene is ready
// (viewGarage fires 'garage:ready'), after 2.5 s at most, or on tap. Reduced motion: no door. Never blocks for long.
function garageDoor() {
  const hash = location.hash || '#/';
  if (!(hash === '#/' || hash === '#')) return;
  try { if (sessionStorage.getItem('garage.door')) return; sessionStorage.setItem('garage.door', '1'); } catch { /* private mode: still play once */ }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const tb = document.querySelector('.topbar');
  const el = document.createElement('div');
  el.className = 'gdoor'; el.setAttribute('aria-hidden', 'true'); el.title = 'Tap to open';
  el.style.top = `${tb ? tb.offsetHeight : 56}px`;
  const panel = cls => `<div class="gd-panel ${cls}">${cls === 'win' ? '<i></i><i></i><i></i><i></i>' : ''}${cls === 'handle' ? '<b></b>' : ''}</div>`;
  el.innerHTML = `<div class="gd-door">${['top', 'win', 'mid', 'mid', 'handle'].map(panel).join('')}<div class="gd-seal"></div></div><div class="gd-lintel"></div>`;
  document.body.appendChild(el);
  let done = false;
  const lift = (fast = false) => {
    if (done) return; done = true;
    el.classList.add(fast ? 'lift-fast' : 'lift');
    const door = el.querySelector('.gd-door');
    const end = () => el.remove();
    door.addEventListener('animationend', end, { once: true });
    setTimeout(end, 2600);   // in case animationend never fires
  };
  el.addEventListener('pointerdown', () => lift(true));
  window.addEventListener('garage:ready', () => setTimeout(() => lift(), 250), { once: true });
  setTimeout(() => lift(), 2500);
  addEventListener('hashchange', () => lift(true), { once: true });
}
garageDoor();

// ---------------------------------------------------------------- app name, no-sign-in warning, push service worker
function applyBranding() {
  const name = CONFIG.app_name || 'Garage';
  const brand = document.querySelector('.brand');
  if (brand && name.toUpperCase() !== 'GARAGE') brand.textContent = name.toUpperCase();
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', name);
  if (!hasInt('email')) document.querySelector('a[href="#/inbox"]')?.remove();
  document.body.classList.toggle('ai-off', CONFIG.ai === false);
  const foot = document.querySelector('footer.site-disclaimer');
  if (foot && CONFIG.version && !foot.querySelector('.app-version')) foot.insertAdjacentHTML('beforeend', ` <span class="app-version">· v${h(CONFIG.version)}</span>`);
  if (CONFIG.auth_mode === 'none' && !document.getElementById('noauth-warning')) {
    const f = document.createElement('footer');
    f.id = 'noauth-warning'; f.className = 'noauth-warning'; f.setAttribute('role', 'alert');
    f.innerHTML = '<strong>No sign-in:</strong> anyone who has this address can see and change this garage. <a href="#/settings">Settings</a>';
    document.body.appendChild(f); document.body.classList.add('has-noauth-warning');
  }
  if (hasInt('push') && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

// ---------------------------------------------------------------- "not professional advice" acknowledgement (once per person)
// Signed-in modes: stored in D1 per member + sign-in name. No-sign-in mode: per browser (localStorage) plus the D1 flag.
async function ensureDisclaimerAck(d) {
  const local = (() => { try { return localStorage.getItem('garage.disclaimer.v1') === 'ok'; } catch { return false; } })();
  const need = CONFIG.auth_mode === 'none' ? !local : !d?.acked;
  if (!need) return;
  await new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back disclaimer-modal';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="disc-h"><h2 id="disc-h">Before you start</h2>
      <p><strong>${h(d?.text || DISCLAIMER_TEXT)}</strong></p>
      <p class="small muted">The research, the AI mechanic and the guided diagnosis can be wrong or out of date. Check part numbers and specs for your exact vehicle, use jack stands, and take the car to a professional when in doubt.</p>
      <p><button type="button" class="btn primary" id="disc-ok">I understand</button></p></div>`;
    document.body.appendChild(back);
    back.querySelector('#disc-ok').focus();
    back.querySelector('#disc-ok').onclick = async () => {
      try { localStorage.setItem('garage.disclaimer.v1', 'ok'); } catch { /* private mode */ }
      try { await api('/api/disclaimer/ack', { method: 'POST', body: {} }); } catch { /* shown again next time */ }
      back.remove(); resolve();
    };
  });
}

// ---------------------------------------------------------------- boot
(async () => {
  let me;
  try { me = await api('/api/me'); ME = me.member; CONFIG = { ...CONFIG, ...me.config }; } catch { return; }
  document.getElementById('who').textContent = CONFIG.auth_mode === 'none' ? '' : ME.name?.split(' ')[0] || '';
  applyBranding();
  refreshInboxBadge();
  render();
  setTimeout(() => ensureDisclaimerAck(me.disclaimer), document.querySelector('.gdoor') ? 2200 : 0);   // after the door intro
})();
