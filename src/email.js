// Email-in (optional integration; your own domain + Cloudflare Email Routing): scan-tool reports (Topdon TopScan etc.)
// and receipts sent to MAIL_ADDRESS from an allowlisted sender.
// allowlisted sender -> postal-mime parse -> raw + attachments to storage -> PDF/HTML to text (AI.toMarkdown)
// -> AI extraction (VIN, vehicle, mileage, date, DTCs, readiness, freeze frame) -> match car -> to-dos -> reply.
import PostalMime from 'postal-mime';
import { parseJsonLoose, runWithFallback, textOf } from './ai.js';
import { putBlob, putFile, safeName } from './store.js';
import { newId, nowSec } from './util.js';
import { RECEIPT_TYPES, createReceipt, emailKind } from './receipts.js';

// Absolute links in replies: set per request (index.js) from APP_ORIGIN.
let ORIGIN = '';
export function setEmailOrigin(o) { if (o) ORIGIN = o.replace(/\/$/, ''); }

const MAX_RAW = 25 * 1024 * 1024;
const MAX_TEXT_FOR_AI = 40000;
export const DTC_RE = /\b([PCBU][0-3][0-9A-F]{3})\b/g;
export const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/g;
const CONVERTIBLE = /^(application\/pdf|text\/html|image\/(jpeg|png|webp)|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|text\/csv)$/;

// ---------- pure helpers (unit-tested) ----------
const VIN_W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const VIN_V = Object.fromEntries([...'ABCDEFGH'].map((c, i) => [c, i + 1]).concat([...'JKLMN'].map((c, i) => [c, i + 1]), [['P', 7], ['R', 9]], [...'STUVWXYZ'].map((c, i) => [c, i + 2])));
export function vinCheckOk(vin) {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (/\d/.test(vin[i]) ? Number(vin[i]) : VIN_V[vin[i]]) * VIN_W[i];
  const r = sum % 11;
  return vin[8] === (r === 10 ? 'X' : String(r));
}
export function findVins(text) {
  const out = new Set();
  for (const m of String(text).toUpperCase().matchAll(VIN_RE)) if (/\d/.test(m[1]) && /[A-Z]/.test(m[1]) && vinCheckOk(m[1])) out.add(m[1]);
  return [...out];
}
export function findCodes(text) {
  return [...new Set([...String(text).toUpperCase().matchAll(DTC_RE)].map(m => m[1]))];
}
const norm = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\bchevy\b/g, 'chevrolet').replace(/[^a-z0-9]+/g, ' ').trim();

/** Match by VIN, else year/make/model (must be unique). Returns { car, how } or { car: null }. */
export function matchCar(cars, { vin, year, make, model }) {
  if (vin) {
    const v = cars.find(c => c.vin && c.vin.toUpperCase() === vin.toUpperCase());
    if (v) return { car: v, how: 'VIN' };
  }
  if (make || model) {
    const nm = norm(make), nmo = norm(model);
    const hits = cars.filter(c => {
      if (year && c.year && Number(year) !== Number(c.year)) return false;
      if (nm && c.make && !(norm(c.make).includes(nm) || nm.includes(norm(c.make)))) return false;
      if (nmo && c.model && !(norm(c.model).includes(nmo) || nmo.includes(norm(c.model)))) return false;
      return !!(nm || nmo);
    });
    if (hits.length === 1) return { car: hits[0], how: year ? 'year/make/model' : 'make/model' };
  }
  return { car: null, how: null };
}

export function stripHtml(s) {
  return String(s || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ').replace(/ *\n\s*/g, '\n').trim();
}

/** Normalise the AI's extraction and cross-check it against the text so invented codes/VINs are dropped. */
export function reconcile(ai, text) {
  const upper = String(text).toUpperCase();
  const textCodes = findCodes(text);
  const codes = [];
  const seen = new Set();
  for (const c of Array.isArray(ai?.codes) ? ai.codes : []) {
    const code = String(c?.code || '').toUpperCase().trim();
    if (!/^[PCBU][0-3][0-9A-F]{3}$/.test(code) || seen.has(code) || !upper.includes(code)) continue;
    seen.add(code);
    codes.push({ code, description: str(c.description, 200), module: str(c.module, 80), status: str(c.status, 60) });
  }
  for (const code of textCodes) if (!seen.has(code)) { seen.add(code); codes.push({ code, description: null, module: null, status: null }); }
  let vin = typeof ai?.vin === 'string' ? ai.vin.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  if (!vin || !upper.includes(vin) || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) vin = findVins(text)[0] || null;
  const v = ai?.vehicle || {};
  const year = Number.isInteger(Number(v.year)) && Number(v.year) > 1980 && Number(v.year) < 2100 ? Number(v.year) : null;
  const mileage = Number.isFinite(Number(ai?.mileage)) && Number(ai.mileage) > 0 && Number(ai.mileage) < 2_000_000 ? Math.round(Number(ai.mileage)) : null;
  const scanDate = typeof ai?.scan_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ai.scan_date) ? ai.scan_date : null;
  return {
    vin, year, make: str(v.make, 40), model: str(v.model, 60), engine: str(v.engine, 80),
    vehicle: [year, str(v.make, 40), str(v.model, 60), str(v.engine, 80)].filter(Boolean).join(' ') || null,
    mileage, scan_date: scanDate, codes,
    readiness: str(typeof ai?.readiness === 'string' ? ai.readiness : ai?.readiness ? JSON.stringify(ai.readiness) : null, 2000),
    freeze_frame: str(typeof ai?.freeze_frame === 'string' ? ai.freeze_frame : ai?.freeze_frame ? JSON.stringify(ai.freeze_frame) : null, 4000),
    summary: str(ai?.summary, 600),
  };
}
function str(v, max) { if (v === undefined || v === null) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; }

/** RFC 5322 header block -> Headers (folded lines joined; repeated headers appended, so get() joins them like Cloudflare). */
/** (IMAP email-in, Docker) */
export function parseHeaders(bytes) {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 256 * 1024)));
  const end = text.search(/\r?\n\r?\n/);
  const head = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, ' ');
  const h = new Headers();
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    try { h.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch { /* invalid header name: skip */ }
  }
  return h;
}

// ---------- AI ----------
const EXTRACT_PROMPT = `You extract data from automotive scan-tool reports (Topdon TopScan and similar OBD2 apps).
Return ONLY a JSON object, no prose, with exactly these keys:
{"vin": string|null, "vehicle": {"year": number|null, "make": string|null, "model": string|null, "engine": string|null},
 "mileage": number|null, "scan_date": "YYYY-MM-DD"|null,
 "codes": [{"code": "P0300", "description": string|null, "module": string|null, "status": string|null}],
 "readiness": string|null, "freeze_frame": string|null, "summary": string}
Rules: only include values that appear in the report; use null when absent. Never invent codes, VINs or mileage.
"module" is the control module/system (e.g. "Engine", "ABS", "BCM"). "status" is e.g. "current", "pending", "history", "permanent".
"readiness" is a one-line summary of I/M readiness monitors if present. "freeze_frame" is a compact summary of freeze-frame data if present (e.g. "RPM 750, ECT 92C, load 23%, speed 0").
"summary" is one plain sentence about what the report shows.`;

export async function extractWithAi(env, text) {
  const { res } = await runWithFallback(env, {
    messages: [{ role: 'system', content: EXTRACT_PROMPT }, { role: 'user', content: `Report text:\n\n${text.slice(0, MAX_TEXT_FOR_AI)}` }],
    max_tokens: 4000, temperature: 0,
  });
  return parseJsonLoose(textOf(res));
}

// converted text per attachment buffer, so deciding scan-vs-receipt doesn't convert a PDF twice
const TEXT_MEMO = new WeakMap();
export async function toText(env, att) {
  const key = att.content && typeof att.content === 'object' ? att.content : null;
  if (key && TEXT_MEMO.has(key)) return TEXT_MEMO.get(key);
  const t = await toTextRaw(env, att);
  if (key) TEXT_MEMO.set(key, t);
  return t;
}
async function toTextRaw(env, att) {
  const type = (att.mimeType || '').toLowerCase();
  if (type.startsWith('text/plain')) return new TextDecoder().decode(att.content);
  if (!CONVERTIBLE.test(type)) return null;
  try {
    const [r] = await env.AI.toMarkdown([{ name: att.filename || 'report', blob: new Blob([att.content], { type }) }]);
    if (r?.format === 'error') { console.warn('toMarkdown error', r.error); return type === 'text/html' ? stripHtml(new TextDecoder().decode(att.content)) : null; }
    return r?.data || null;
  } catch (e) {
    console.warn('toMarkdown failed', e.message);
    return type === 'text/html' ? stripHtml(new TextDecoder().decode(att.content)) : null;
  }
}

// ---------- applying a matched scan ----------
export async function applyScanToCar(env, scan, car) {
  const codes = (await env.DB.prepare('SELECT * FROM scan_codes WHERE scan_id = ?1').bind(scan.id).all()).results;
  const created = [];
  const when = scan.scan_date || new Date((scan.received_at || nowSec()) * 1000).toISOString().slice(0, 10);
  for (const c of codes) {
    const existing = await env.DB.prepare("SELECT * FROM todos WHERE car_id = ?1 AND dtc_code = ?2 AND status = 'open'").bind(car.id, c.code).first();
    const line = `Seen in scan on ${when}${scan.mileage ? ` at ${scan.mileage.toLocaleString('en-US')} mi` : ''}${c.module ? ` (${c.module})` : ''}${c.status ? `, ${c.status}` : ''}.`;
    if (existing) {
      await env.DB.prepare('UPDATE todos SET notes = ?1 WHERE id = ?2').bind(`${existing.notes ? existing.notes + '\n' : ''}${line}`.slice(-8000), existing.id).run();
    } else {
      const id = newId();
      await env.DB.prepare("INSERT INTO todos (id, car_id, title, notes, priority, status, dtc_code, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7)")
        .bind(id, car.id, `Diagnose ${c.code}${c.description ? ` (${c.description})` : ''}`.slice(0, 200),
          `${line}\nAsk the mechanic tab for what to check first. Code descriptions from the scan tool; verify before buying parts.`, c.code.startsWith('P03') || c.code.startsWith('P02') ? 'high' : 'medium', c.code, nowSec()).run();
      created.push(c.code);
    }
  }
  if (scan.mileage) await env.DB.prepare('UPDATE cars SET mileage = ?1, mileage_updated_at = ?2 WHERE id = ?3 AND (mileage IS NULL OR mileage < ?1)').bind(scan.mileage, when, car.id).run();
  return created;
}

/**
 * Shared pipeline for emailed and uploaded reports.
 * input: { from, subject, text, html, attachments:[{filename,mimeType,content}], rawBytes?, forceCar? }
 */
export async function processReport(env, input) {
  const scanId = newId();
  const notes = [];
  let rawKey = null;
  if (input.rawBytes) { rawKey = `scans/${scanId}/message.eml`; await putBlob(env, rawKey, input.rawBytes, 'message/rfc822'); }

  // Insert the scan row first so file rows can reference it.
  await env.DB.prepare('INSERT INTO scans (id, car_id, received_at, from_addr, subject, raw_key) VALUES (?1, NULL, ?2, ?3, ?4, ?5)')
    .bind(scanId, nowSec(), input.from || null, (input.subject || '').slice(0, 300), rawKey).run();

  const parts = [];
  if (input.subject) parts.push(`Subject: ${input.subject}`);
  const bodyText = input.text || (input.html ? stripHtml(input.html) : '');
  if (bodyText) parts.push(bodyText);
  let converted = 0;
  for (const att of input.attachments || []) {
    const name = safeName(att.filename || 'attachment');
    const type = (att.mimeType || 'application/octet-stream').toLowerCase();
    await putFile(env, { key: `scans/${scanId}/${name}`, data: att.content, contentType: type, filename: name, scanId, carId: input.forceCar?.id || null });
    const t = await toText(env, { ...att, mimeType: type });
    if (t) { parts.push(`--- ${name} ---\n${t}`); converted++; }
    else notes.push(`Stored ${name} (${type}) without reading it.`);
  }
  if (input.html && !input.text) {
    // keep the HTML body as a file too (HTML report emails)
    await putFile(env, { key: `scans/${scanId}/body.html`, data: new TextEncoder().encode(input.html), contentType: 'text/html', filename: 'body.html', scanId, carId: input.forceCar?.id || null });
  }
  const links = [...new Set((bodyText.match(/https?:\/\/[^\s<>"')]+/g) || []))].filter(u => /topdon|topscan|report|share/i.test(u)).slice(0, 5);
  if (links.length) notes.push(`Report link(s) in the message, not fetched automatically: ${links.join(' ')}`);
  if (!converted && !(input.attachments || []).length) notes.push('No attachment; only the message body was read.');

  const text = parts.join('\n\n');
  const textKey = `scans/${scanId}/report.md`;
  await putBlob(env, textKey, text, 'text/markdown; charset=utf-8');

  let ai = null;
  try { ai = await extractWithAi(env, text); } catch (e) { console.error('extract failed', e.message); notes.push(`AI extraction failed: ${e.message}`); }
  if (!ai) notes.push('AI extraction returned nothing usable; codes/VIN found by pattern only.');
  const x = reconcile(ai || {}, text);

  const { results: cars } = await env.DB.prepare('SELECT * FROM cars WHERE archived = 0').all();
  const match = input.forceCar ? { car: input.forceCar, how: 'uploaded on car page' } : matchCar(cars, x);

  await env.DB.prepare(`UPDATE scans SET car_id = ?1, vin = ?2, vehicle = ?3, mileage = ?4, scan_date = ?5, summary = ?6, readiness = ?7, freeze_frame = ?8,
      match_how = ?9, note = ?10, text_key = ?11 WHERE id = ?12`)
    .bind(match.car?.id || null, x.vin, x.vehicle, x.mileage, x.scan_date, x.summary, x.readiness, x.freeze_frame, match.how, notes.join('\n') || null, textKey, scanId).run();
  if (match.car) await env.DB.prepare('UPDATE files SET car_id = ?1 WHERE scan_id = ?2').bind(match.car.id, scanId).run();
  if (x.codes.length) await env.DB.batch(x.codes.map(c => env.DB.prepare('INSERT INTO scan_codes (id, scan_id, code, description, module, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(newId(), scanId, c.code, c.description, c.module, c.status)));
  let createdTodos = [];
  if (match.car) createdTodos = await applyScanToCar(env, { id: scanId, received_at: nowSec(), scan_date: x.scan_date, mileage: x.mileage }, match.car);
  return { scan_id: scanId, car: match.car ? { id: match.car.id, nickname: match.car.nickname } : null, match_how: match.how, vin: x.vin, vehicle: x.vehicle, mileage: x.mileage, codes: x.codes, new_todos: createdTodos, notes };
}

// ---------- the email() handler ----------
const addr = a => String(a || '').trim().toLowerCase();

/**
 * Is this message from an allowlisted sender? The header From is what DMARC protects, so an allowlisted header From
 * passes unless the receiving server recorded dmarc=fail. An allowlisted envelope sender alone (auto-forwarded mail,
 * where the header From is the store) is trusted only when every SPF verdict recorded for it is "pass": the envelope
 * address is otherwise trivially forged. Only failures are matched in the headers, never a lone "pass" text: a sender
 * can add their own Authentication-Results header, but can't remove the one Cloudflare adds.
 * headers: anything with get(name) (the message's Headers).
 */
export function senderCheck({ envelopeFrom, headerFrom, allowed, headers }) {
  const h = n => String(headers?.get?.(n) || '');
  const auth = `${h('Authentication-Results')} ${h('ARC-Authentication-Results')}`;
  if (/\bdmarc=fail\b/i.test(auth)) return { ok: false, reason: 'dmarc=fail', reject: 'Failed DMARC' };
  if (headerFrom && allowed.has(headerFrom)) return { ok: true, how: 'header' };
  if (envelopeFrom && allowed.has(envelopeFrom)) {
    const spf = [...auth.matchAll(/\bspf=(\w+)/gi), ...h('Received-SPF').matchAll(/(?:^|,)\s*(pass|fail|softfail|neutral|none|temperror|permerror)\b/gi)].map(m => m[1].toLowerCase());
    if (spf.length && spf.every(v => v === 'pass')) return { ok: true, how: 'envelope' };
    return { ok: false, reason: `envelope sender allowlisted but SPF is ${spf.join('/') || 'missing'}`, reject: 'Sender not verified' };
  }
  return { ok: false, reason: 'sender not allowlisted', reject: 'Sender not allowed' };
}

export function replyText(r) {
  const lines = [];
  lines.push(r.car ? `Matched to: ${r.car.nickname} (by ${r.match_how}).` : `Couldn't match this to a car${r.vehicle ? ` (report says: ${r.vehicle})` : ''}. It's in the Unmatched inbox at ${ORIGIN}/#/inbox to assign.`);
  if (r.vin) lines.push(`VIN: ${r.vin}`);
  if (r.mileage) lines.push(`Mileage: ${r.mileage.toLocaleString('en-US')}`);
  lines.push(r.codes.length ? `Codes found (${r.codes.length}):` : 'No trouble codes found.');
  for (const c of r.codes.slice(0, 30)) lines.push(`  ${c.code}${c.description ? ` - ${c.description}` : ''}${c.module ? ` [${c.module}]` : ''}`);
  if (r.new_todos.length) lines.push(`New to-dos: ${r.new_todos.map(c => `Diagnose ${c}`).join(', ')}`);
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push('', ORIGIN || 'Open the garage app to see it.');
  return lines.join('\n');
}

async function sendReply(message, env, subject, body) {
  const { EmailMessage } = await import('cloudflare:email');
  const clean = s => String(s || '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '').slice(0, 200);
  const orig = message.headers.get('Message-ID');
  const raw = [
    `From: ${clean(env.APP_NAME || 'Garage')} <${env.MAIL_ADDRESS}>`,
    `To: ${clean(message.from)}`,
    `Subject: Re: ${clean(subject) || 'your scan report'}`,
    `Message-ID: <${newId()}@${String(env.MAIL_ADDRESS || 'garage@localhost').split('@')[1]}>`,
    ...(orig ? [`In-Reply-To: ${clean(orig)}`, `References: ${clean(orig)}`] : []),
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', body,
  ].join('\r\n');
  await message.reply(new EmailMessage(env.MAIL_ADDRESS, message.from, raw));
}

export async function handleEmail(message, env) {
  const envelopeFrom = addr(message.from);
  if (message.rawSize > MAX_RAW) { message.setReject('Message too large'); return; }
  const rawBytes = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(rawBytes, { attachmentEncoding: 'arraybuffer' });
  const headerFrom = addr(parsed.from?.address);
  const { results } = await env.DB.prepare('SELECT email FROM senders').all();
  const allowed = new Set(results.map(r => addr(r.email)));
  const verdict = senderCheck({ envelopeFrom, headerFrom, allowed, headers: message.headers });
  if (!verdict.ok) {
    console.log(`email rejected: ${verdict.reason} (envelope=${envelopeFrom} header=${headerFrom})`);
    message.setReject(verdict.reject);
    return;
  }
  // skip small inline images (signatures, logos); keep everything else
  const attachments = (parsed.attachments || []).filter(a => a.content && !(a.disposition === 'inline' && /^image\//i.test(a.mimeType || '') && a.content.byteLength < 20000));
  const from = headerFrom || envelopeFrom;
  // scan-tool report or receipt? Subject/body/sender first; when that can't tell, read the PDFs (cached for the scan path).
  const base = { subject: parsed.subject || '', text: parsed.text || '', html: parsed.html || '', attachments };
  let kind = emailKind(base);
  const pdfs = attachments.filter(a => /pdf/i.test(a.mimeType || ''));
  if (pdfs.length && !/\b(receipt|invoice|order|scan|topdon|topscan|diagnos\w*|dtc|obd)\b/i.test(base.subject)) {
    const extra = [];
    for (const a of pdfs.slice(0, 3)) extra.push(await toText(env, { ...a, mimeType: 'application/pdf' }) || '');
    kind = emailKind({ ...base, extraText: extra.join('\n') });
  }
  if (kind === 'receipt') return handleReceiptEmail(message, env, parsed, { from, attachments });
  const r = await processReport(env, {
    from, subject: parsed.subject || '', text: parsed.text || '', html: parsed.html || '', attachments, rawBytes,
  });
  console.log(`email processed scan=${r.scan_id} car=${r.car?.nickname || 'unmatched'} codes=${r.codes.map(c => c.code).join(',')}`);
  try { await sendReply(message, env, parsed.subject, replyText(r)); console.log('reply sent'); }
  catch (e) { console.warn('reply skipped:', e.message); }
  return r;
}

// ---------- receipts by email (forwarded shop invoices, parts-store receipts, RockAuto order confirmations, photos)
export function receiptReplyText(res) {
  const v = res.receipt;
  if (res.duplicate) return [`Already have this receipt (${v.status === 'saved' ? 'saved to the history' : 'waiting for you to check it'}): ${v.url}`, '', v.summary].join('\n');
  return [
    v.parse_status === 'failed' ? `Got it, but couldn't read it all${v.error ? ` (${v.error})` : ''}. Fill it in here: ${v.url}` : `Got your receipt. It's waiting for you to check: ${v.url}`,
    '', v.summary, '', 'Nothing is logged until you tap Save in the app.',
  ].join('\n');
}

async function handleReceiptEmail(message, env, parsed, { from, attachments }) {
  const files = attachments.filter(a => RECEIPT_TYPES.test((a.mimeType || '').toLowerCase()) && !/^text\//i.test(a.mimeType || ''))
    .slice(0, 8).map(a => ({ name: a.filename || 'receipt', mime: a.mimeType, data: a.content }));
  const m = await env.DB.prepare('SELECT id, name FROM members WHERE email = ?1 COLLATE NOCASE').bind(from).first();
  const res = await createReceipt(env, {
    source: 'email', files, text: parsed.text || '', html: parsed.html || '', from, subject: parsed.subject || '',
    member: { id: m?.id || null, name: `${m?.name || from} by email` }, notify: true,
  });
  console.log(`email receipt ${res.receipt.id} ${res.duplicate ? '(duplicate)' : ''} car=${res.receipt.car?.nickname || '?'}`);
  try { await sendReply(message, env, parsed.subject, receiptReplyText(res)); } catch (e) { console.warn('reply skipped:', e.message); }
  return { kind: 'receipt', ...res };
}
