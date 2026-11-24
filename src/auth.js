// Sign-in. AUTH_MODE (garage.config.json "auth.mode"):
//   password           (default) one household password, PBKDF2-hashed in the secret PASSWORD_HASH; a session cookie
//                      (gr_session, rows in D1 `sessions`). Everyone is the built-in "household" member; each session
//                      remembers the name typed at sign-in, so to-dos and services still say who added them.
//   none               no sign-in at all. Anyone with the URL can read and change everything. Loud warning in the UI.
//   cloudflare-access  the site sits behind Cloudflare Access; we verify the Cf-Access-Jwt-Assertion header
//                      (ACCESS_TEAM_DOMAIN + ACCESS_AUD). Each Access email becomes a member automatically.
//   oidc               generic OpenID Connect (src/oidc.js); members are matched by subject, or a pending member by
//                      email on first sign-in (Settings -> Members).
// The MCP OAuth consent page (/authorize) uses the same sign-in, so Claude connectors work in every mode.
import { completeLogin, cookie, readCookie, safeNext, startLogin, verifyJwt } from './oidc.js';
import { HttpError, esc, newId, nowSec, page, randomToken, sha256Hex } from './util.js';

export const SESSION_COOKIE = 'gr_session';
const TTL = 60 * 86400;
export const HOUSEHOLD_ID = 'm-household';
export const AUTH_MODES = ['password', 'none', 'cloudflare-access', 'oidc'];

export function authMode(env) {
  const m = String(env.AUTH_MODE || 'password').toLowerCase().trim();
  return AUTH_MODES.includes(m) ? m : 'password';
}

async function household(env, name) {
  const m = await env.DB.prepare('SELECT id, email, name, is_owner FROM members WHERE id = ?1').bind(HOUSEHOLD_ID).first();
  if (!m) throw new HttpError(424, 'The household member is missing: run the D1 migrations (see the setup-garage skill)');
  return { id: m.id, email: null, name: name || m.name || 'Household', is_owner: true };
}

// ---------------------------------------------------------------- password hashing (PBKDF2-SHA256)
const ITER = 100000;   // the Workers runtime caps PBKDF2 at 100k iterations
const b64 = u8 => btoa(String.fromCharCode(...new Uint8Array(u8)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
/** "pbkdf2$<iterations>$<salt b64>$<hash b64>" (scripts/set-password.mjs makes the same format). */
export async function hashPassword(password, iter = ITER) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iter}$${b64(salt)}$${b64(await pbkdf2(password, salt, iter))}`;
}
export async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2' || !iter || !salt || !hash) return false;
  const got = await pbkdf2(String(password), unb64(salt), Math.min(Number(iter), ITER));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let r = 0; for (let i = 0; i < got.length; i++) r |= got[i] ^ want[i];
  return r === 0;
}

// ---------------------------------------------------------------- Cloudflare Access
async function accessClaims(req, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!team || !env.ACCESS_AUD) throw new HttpError(424, 'Cloudflare Access mode needs ACCESS_TEAM_DOMAIN and ACCESS_AUD');
  const token = req.headers.get('Cf-Access-Jwt-Assertion') || readCookie(req, 'CF_Authorization');
  if (!token) return null;
  try {
    const c = await verifyJwt(token, { jwksUri: `https://${team}/cdn-cgi/access/certs`, issuer: `https://${team}`, audience: env.ACCESS_AUD });
    return c.email ? c : null;
  } catch (e) { console.warn('access jwt rejected', e.message); return null; }
}
async function accessMember(env, email) {
  const e = String(email).trim().toLowerCase();
  let m = await env.DB.prepare('SELECT id, email, name, is_owner FROM members WHERE email = ?1 COLLATE NOCASE').bind(e).first();
  if (!m) {
    m = { id: newId(), email: e, name: e.split('@')[0], is_owner: 1 };
    await env.DB.prepare('INSERT OR IGNORE INTO members (id, email, sub, name, is_owner, created_at) VALUES (?1, ?2, NULL, ?3, 1, ?4)').bind(m.id, e, m.name, nowSec()).run();
    m = await env.DB.prepare('SELECT id, email, name, is_owner FROM members WHERE email = ?1 COLLATE NOCASE').bind(e).first();
  }
  return { id: m.id, email: m.email, name: m.name || m.email, is_owner: !!m.is_owner };
}

// ---------------------------------------------------------------- who is this request?
export async function currentMember(req, env) {
  const mode = authMode(env);
  if (mode === 'none') return household(env);
  if (mode === 'cloudflare-access') {
    const c = await accessClaims(req, env);
    return c ? accessMember(env, c.email) : null;
  }
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT m.id, m.email, m.name, m.is_owner, s.name AS session_name, s.expires_at FROM sessions s JOIN members m ON m.id = s.member_id
    WHERE s.token_hash = ?1`).bind(await sha256Hex(token)).first();
  if (!row || row.expires_at < nowSec()) return null;
  if (mode === 'password') {
    if (row.id !== HOUSEHOLD_ID) return null;          // sessions from another mode don't carry over
    return { id: row.id, email: null, name: row.session_name || row.name || 'Household', is_owner: true };
  }
  if (row.id === HOUSEHOLD_ID) return null;
  return { id: row.id, email: row.email, name: row.name || row.email, is_owner: !!row.is_owner };
}

async function memberFor(env, claims) {
  let m = await env.DB.prepare('SELECT * FROM members WHERE sub = ?1').bind(claims.sub).first();
  if (m) return m;
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || claims.email_verified === false) return null;
  m = await env.DB.prepare('SELECT * FROM members WHERE email = ?1 COLLATE NOCASE AND sub IS NULL').bind(email).first();
  if (!m) return null;
  await env.DB.prepare('UPDATE members SET sub = ?1, name = COALESCE(name, ?2) WHERE id = ?3').bind(claims.sub, claims.name || null, m.id).run();
  return m;
}

async function startSession(env, req, memberId, name, next, extraCookies = []) {
  const token = randomToken(32), now = nowSec();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, member_id, name, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(await sha256Hex(token), memberId, name || null, now, now + TTL),
  ]);
  const h = new Headers({ Location: next, 'Cache-Control': 'no-store' });
  h.append('Set-Cookie', cookie(SESSION_COOKIE, token, TTL, req));
  for (const c of extraCookies) h.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers: h });
}

export function loginPage(env, next, error = '', status = 200) {
  const app = esc(env.APP_NAME || 'Garage');
  return page(`Sign in to ${env.APP_NAME || 'Garage'}`, `${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/auth/login" class="login-form">
<input type="hidden" name="next" value="${esc(safeNext(next))}">
<input type="text" name="username" value="household" autocomplete="username" hidden aria-hidden="true">
<div class="field"><label for="pw">Household password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus></div>
<div class="field"><label for="nm">Your name <span class="muted small">(optional; shows who logged what)</span></label><input id="nm" name="name" maxlength="40" autocomplete="nickname"></div>
<p><button class="btn primary" type="submit">Sign in</button></p></form>
<p class="small muted">${app} is private. Forgot the password? Whoever set it up can change it (<code>npm run set-password</code>, or GARAGE_PASSWORD in Docker).</p>`, status);
}

export async function handleAuth(req, env, url) {
  const mode = authMode(env);
  if (url.pathname === '/auth/login') {
    const next = url.searchParams.get('next') || '/';
    if (mode === 'none' || mode === 'cloudflare-access') return Response.redirect(new URL(safeNext(next), url.origin).toString(), 302);
    if (mode === 'oidc') return startLogin(req, env, next);
    if (req.method === 'GET') return loginPage(env, next);
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (env.LOGIN_LIMITER) {
      const ip = req.headers.get('CF-Connecting-IP') || 'local';
      const { success } = await env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
      if (!success) return loginPage(env, next, 'Too many tries. Wait a minute and try again.', 429);
    }
    const form = await req.formData();
    const nextF = safeNext(String(form.get('next') || '/'));
    if (!env.PASSWORD_HASH) return loginPage(env, nextF, 'No password is set yet. Cloudflare: run `npm run set-password`. Docker: set GARAGE_PASSWORD (or PASSWORD_HASH) and restart the container.', 424);
    if (!(await verifyPassword(String(form.get('password') || ''), env.PASSWORD_HASH))) {
      console.log('login: wrong password');
      return loginPage(env, nextF, "That password didn't work.", 401);
    }
    const name = String(form.get('name') || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || null;
    return startSession(env, req, HOUSEHOLD_ID, name, nextF);
  }
  if (url.pathname === '/auth/callback' && mode === 'oidc') {
    const r = await completeLogin(req, env);
    if (r instanceof Response) return r;
    const m = await memberFor(env, r.claims);
    if (!m) {
      const res = page('Not on the list', `<p>Your account (${esc(r.claims.email || r.claims.name || r.claims.sub)}) isn't a member of this garage yet. Ask the garage owner to add your email in Settings → Members.</p>`, 403);
      res.headers.append('Set-Cookie', r.clearFlow);
      return res;
    }
    return startSession(env, req, m.id, r.claims.name || r.claims.email || null, r.next, [r.clearFlow]);
  }
  if (url.pathname === '/auth/logout') {
    if (req.method !== 'POST') return new Response('Use POST', { status: 405 });
    if (mode === 'cloudflare-access') return new Response(null, { status: 303, headers: { Location: '/cdn-cgi/access/logout' } });
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
    return new Response(null, { status: 303, headers: { Location: '/signed-out', 'Set-Cookie': cookie(SESSION_COOKIE, '', 0, req) } });
  }
  return null;
}
