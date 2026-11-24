// Notifications through whichever optional integrations are enabled (garage.config.json "integrations"):
//   push            web push to every subscribed browser / home-screen app (VAPID; iOS 16.4+ home-screen web apps too)
//   home_assistant  HA notify services (HA_URL + secret HA_TOKEN; HA must be reachable from the internet)
//   email           a short email to verified addresses via the Email Routing send_email binding (NOTIFY_EMAIL)
// Every notification is also stored in `notifications` (the push service worker reads it; pushes carry no payload).
import { nowSec } from './util.js';
import { sendPushToAll } from './push.js';

export function integrations(env) {
  return new Set(String(env.INTEGRATIONS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}
export const enabled = (env, name) => integrations(env).has(name);

/** App origin for absolute links (APP_ORIGIN var, else what index.js saw on the request). */
let ORIGIN = '';
export function setNotifyOrigin(o) { if (o) ORIGIN = o.replace(/\/$/, ''); }
export const absUrl = (env, hash) => `${(env.APP_ORIGIN || ORIGIN || '').replace(/\/$/, '')}/${hash ? String(hash).replace(/^\/?/, '') : ''}`;

/**
 * notify(env, { kind, title, body, url }) -> { id, channels: { push, home_assistant, email } }
 * url is an in-app link like "#/car/<id>/todo". Never throws (a failing channel is logged and reported).
 */
export async function notify(env, { kind = 'info', title, body = '', url = '', haData = null }) {
  const t = String(title || 'Garage').slice(0, 120), b = String(body || '').slice(0, 400), u = String(url || '').slice(0, 300);
  let id = null;
  try {
    const r = await env.DB.prepare('INSERT INTO notifications (at, kind, title, body, url) VALUES (?1, ?2, ?3, ?4, ?5)').bind(nowSec(), kind, t, b, u).run();
    id = r.meta?.last_row_id ?? null;
    await env.DB.prepare('DELETE FROM notifications WHERE at < ?1').bind(nowSec() - 30 * 86400).run();
  } catch (e) { console.error('notify: store failed', e.message); }
  const on = integrations(env), channels = {};
  const tryCh = async (name, fn) => { if (!on.has(name)) return; try { channels[name] = await fn(); } catch (e) { channels[name] = { ok: false, error: String(e.message).slice(0, 200) }; console.warn(`notify ${name} failed`, e.message); } };
  await tryCh('push', () => sendPushToAll(env));
  await tryCh('home_assistant', () => haNotify(env, { title: t, message: b, url: u ? absUrl(env, u) : absUrl(env, ''), extra: haData }));
  await tryCh('email', () => emailNotify(env, { title: t, message: b, url: u ? absUrl(env, u) : absUrl(env, '') }));
  console.log(`notify ${kind}: ${Object.entries(channels).map(([k, v]) => `${k}=${v?.ok === false ? 'fail' : 'ok'}`).join(' ') || 'stored only (no channel enabled)'}`);
  return { id, channels };
}

// ---------------------------------------------------------------- Home Assistant
const haTargets = env => String(env.HA_NOTIFY_TARGETS || '').split(',').map(s => s.trim().replace(/^notify\./, '')).filter(Boolean);

async function haFetch(env, path, body) {
  if (!env.HA_URL || !env.HA_TOKEN) throw new Error('HA_URL / HA_TOKEN not set');
  const r = await fetch(`${env.HA_URL.replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.HA_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HA ${path} -> ${r.status}`);
  return r;
}

export async function haNotify(env, { title, message, url, extra = null }) {
  const targets = haTargets(env);
  if (!targets.length) throw new Error('HA_NOTIFY_TARGETS is empty');
  const out = [];
  for (const t of targets) {
    if (!/^[a-z0-9_]+$/.test(t)) { out.push({ target: t, ok: false, error: 'bad target name' }); continue; }
    try { await haFetch(env, `/api/services/notify/${t}`, { title, message, data: url || extra ? { ...(url ? { url, clickAction: url } : {}), ...(extra || {}) } : undefined }); out.push({ target: t, ok: true }); }
    catch (e) { out.push({ target: t, ok: false, error: e.message }); }
  }
  return { ok: out.some(o => o.ok), targets: out };
}

/** sensor.garage_due_count with overdue / due-soon details (daily, when HA is enabled). */
export async function haSetDueSensor(env, due) {
  const attrs = { friendly_name: `${env.APP_NAME || 'Garage'} items due`, icon: 'mdi:car-wrench', url: absUrl(env, '#/due'),
    overdue: due.items.filter(i => i.status === 'overdue').map(i => `${i.car}: ${i.name}`),
    due_soon: due.items.filter(i => i.status === 'soon').map(i => `${i.car}: ${i.name}`),
    open_todos: due.todos.filter(t => t.priority === 'high').map(t => `${t.car}: ${t.title}`) };
  await haFetch(env, '/api/states/sensor.garage_due_count', { state: String(attrs.overdue.length + attrs.due_soon.length), attributes: attrs });
  return { ok: true };
}

// ---------------------------------------------------------------- email
async function emailNotify(env, { title, message, url }) {
  const to = String(env.NOTIFY_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!env.NOTIFY_EMAIL || !env.MAIL_ADDRESS || !to.length) throw new Error('email notifications need MAIL_ADDRESS, NOTIFY_EMAIL_TO and the NOTIFY_EMAIL binding');
  const { EmailMessage } = await import('cloudflare:email');
  const clean = s => String(s || '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '').slice(0, 200);
  const results = [];
  for (const addr of to.slice(0, 5)) {
    const raw = [`From: ${clean(env.APP_NAME || 'Garage')} <${env.MAIL_ADDRESS}>`, `To: ${clean(addr)}`, `Subject: ${clean(title)}`,
      `Message-ID: <${crypto.randomUUID()}@${String(env.MAIL_ADDRESS).split('@')[1]}>`, `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', message || title, '', url || ''].join('\r\n');
    try { await env.NOTIFY_EMAIL.send(new EmailMessage(env.MAIL_ADDRESS, addr, raw)); results.push({ to: addr, ok: true }); }
    catch (e) { results.push({ to: addr, ok: false, error: e.message }); }
  }
  return { ok: results.some(r => r.ok), results };
}

/** Once-only bookkeeping: true if `key` was not announced within `withinSec` (and records it now). */
export async function firstTime(env, key, withinSec) {
  const row = await env.DB.prepare('SELECT at FROM notify_state WHERE key = ?1').bind(key).first();
  if (row && row.at > nowSec() - withinSec) return false;
  await env.DB.prepare('INSERT INTO notify_state (key, at) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET at = excluded.at').bind(key, nowSec()).run();
  return true;
}
