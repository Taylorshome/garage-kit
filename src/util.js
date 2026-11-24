export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

export const newId = () => crypto.randomUUID();
export const nowSec = () => Math.floor(Date.now() / 1000);

export function randomToken(bytes = 32) {
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', typeof text === 'string' ? new TextEncoder().encode(text) : text);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish string compare for bearer tokens. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Same text as src/disclaimer.js (kept here too so util.js has no imports).
const DISCLAIMER_FOOTER = 'Not professional advice. This information comes from AI and online research, not a certified mechanic. Verify before acting, follow safety precautions, and do all work at your own risk.';
export function page(title, bodyHtml, status = 200) {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/styles.css"><body class="plain-page"><main class="plain-card"><h1>${esc(title)}</h1>${bodyHtml}</main>
<footer class="site-disclaimer small muted">${esc(DISCLAIMER_FOOTER)}</footer></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ---- input validation helpers ----
export function str(v, max = 2000, { required = false, name = 'value' } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw new HttpError(400, `${name} is required`); return null; }
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${name} must be text`);
  const s = String(v).trim();
  if (!s) { if (required) throw new HttpError(400, `${name} is required`); return null; }
  return s.slice(0, max);
}
export function int(v, { min = 0, max = 10_000_000, name = 'value' } = {}) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[, ]/g, ''));
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return Math.round(n);
}
export function date(v, { required = false, name = 'date' } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw new HttpError(400, `${name} is required`); return null; }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw new HttpError(400, `${name} must be YYYY-MM-DD`);
  return v;
}
export function money(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[$, ]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new HttpError(400, 'cost must be a dollar amount');
  return Math.round(n * 100);
}
export function email(v, { name = 'email' } = {}) {
  const s = str(v, 254, { required: true, name });
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)) throw new HttpError(400, `${name} is not a valid email address`);
  return s.toLowerCase();
}
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const BODY_TYPES = ['sedan', 'coupe', 'hatchback', 'minivan', 'suv', 'pickup'];

/** The garage's time zone (garage.config.json "timezone" -> var TIMEZONE); set once per request by index.js. */
export let TZ = 'UTC';
export function setTimezone(tz) {
  if (!tz || tz === TZ) return;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); TZ = tz; } catch { console.warn(`TIMEZONE "${tz}" is not a valid IANA zone; using ${TZ}`); }
}
/** Today in the garage's time zone as YYYY-MM-DD. */
export function todayLocal(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
