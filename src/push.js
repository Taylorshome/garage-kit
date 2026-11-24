// Web push (optional integration "push"). VAPID keys are generated at setup (scripts/gen-vapid.mjs):
//   var VAPID_PUBLIC_KEY  = uncompressed P-256 public key, base64url (65 bytes)
//   secret VAPID_PRIVATE_KEY = the private scalar d, base64url (32 bytes)
// Pushes carry NO payload, so no message encryption is needed: the service worker (public/sw.js) fetches the
// newest rows from /api/notifications/recent with the signed-in cookie and shows them.
// iOS / iPadOS 16.4+: works for the app added to the Home Screen (Share -> Add to Home Screen), not in a Safari tab.
import { HttpError, newId, nowSec, str } from './util.js';

const b64u = bytes => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = v => { const p = String(v).replace(/-/g, '+').replace(/_/g, '/'); const s = atob(p + '='.repeat((4 - (p.length % 4)) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); };

let keyCache = null;
async function vapidKey(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error('VAPID keys are not set (run scripts/gen-vapid.mjs at setup)');
  if (keyCache?.pub === env.VAPID_PUBLIC_KEY) return keyCache.key;
  const pub = unb64u(env.VAPID_PUBLIC_KEY);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY must be an uncompressed P-256 key');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY, ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  keyCache = { pub: env.VAPID_PUBLIC_KEY, key };
  return key;
}

/** VAPID JWT for one push service origin (ES256; WebCrypto already returns the raw r||s form JWS wants). */
export async function vapidJwt(env, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ typ: 'JWT', alg: 'ES256' });
  const body = enc({ aud, exp: nowSec() + 12 * 3600, sub: subject });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidKey(env), new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}

function subjectOf(env) {
  const s = env.VAPID_SUBJECT || env.APP_ORIGIN || '';
  return /^(mailto:|https:)/.test(s) ? s : 'mailto:garage@example.invalid';
}

/** Tickle every subscription; drop the ones the push service says are gone. */
export async function sendPushToAll(env) {
  const { results } = await env.DB.prepare('SELECT * FROM push_subscriptions').all();
  if (!results.length) return { ok: true, sent: 0, note: 'no subscribed devices' };
  let sent = 0, removed = 0, failed = 0;
  for (const s of results) {
    try {
      const jwt = await vapidJwt(env, s.endpoint, subjectOf(env));
      const r = await fetch(s.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'normal', Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`, 'Content-Length': '0' } });
      if (r.status === 404 || r.status === 410) { await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?1').bind(s.id).run(); removed++; continue; }
      if (!r.ok) throw new Error(`push service ${r.status}`);
      await env.DB.prepare('UPDATE push_subscriptions SET last_ok_at = ?1, fail_count = 0 WHERE id = ?2').bind(nowSec(), s.id).run();
      sent++;
    } catch (e) {
      failed++;
      console.warn('push failed', new URL(s.endpoint).host, e.message);
      await env.DB.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?1').bind(s.id).run();
    }
  }
  return { ok: failed === 0 || sent > 0, sent, removed, failed };
}

const ALLOWED_PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.microsoft\.com)$/;

export async function subscribe(env, member, body, ua = '') {
  const sub = body?.subscription || body;
  const endpoint = str(sub?.endpoint, 1000, { required: true, name: 'endpoint' });
  let u; try { u = new URL(endpoint); } catch { throw new HttpError(400, 'endpoint must be a URL'); }
  if (u.protocol !== 'https:' || !ALLOWED_PUSH_HOSTS.test(u.hostname)) throw new HttpError(400, 'Not a known browser push service');
  const label = /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Browser';
  await env.DB.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, member_id, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(endpoint) DO UPDATE SET member_id = excluded.member_id, label = excluded.label`)
    .bind(newId(), endpoint, sub?.keys?.p256dh || null, sub?.keys?.auth || null, member?.id || null, label, nowSec()).run();
  return { ok: true, label };
}

export async function unsubscribe(env, body) {
  const endpoint = str(body?.endpoint, 1000, { required: true, name: 'endpoint' });
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint).run();
  return { ok: true };
}

export async function recentNotifications(env, { sinceSec = 15 * 60, limit = 5 } = {}) {
  const { results } = await env.DB.prepare('SELECT id, at, kind, title, body, url FROM notifications WHERE at > ?1 ORDER BY id DESC LIMIT ?2').bind(nowSec() - sinceSec, limit).all();
  return results;
}
