// Generic OpenID Connect sign-in (auth mode "oidc"): any provider with discovery (Google, Microsoft Entra, Auth0,
// Authentik, Keycloak, Pocket ID, ...). Authorization code flow with PKCE S256 + state + nonce, confidential client
// (client_secret_basic, or client_secret_post when OIDC_TOKEN_AUTH=post). No npm dependency: WebCrypto verifies the
// RS256/ES256 id_token and signs the short-lived flow cookie. The app keeps its own session (gr_session in D1).
// Config: vars OIDC_ISSUER + OIDC_CLIENT_ID, secret OIDC_CLIENT_SECRET; redirect URI = <origin>/auth/callback.
//
// gr_flow holds the in-flight login { state, verifier, nonce, next }, signed with SESSION_SECRET.
// It must be SameSite=Lax: the callback is a cross-site top-level navigation from the IdP.

const FLOW_COOKIE = 'gr_flow';
const FLOW_TTL = 600;
const SKEW = 120;

const discoCache = new Map();
/** Endpoints from <issuer>/.well-known/openid-configuration (cached 1 h per isolate). */
export async function oidcConfig(env) {
  const issuer = String(env.OIDC_ISSUER || '').replace(/\/$/, '');
  const base = { issuer, clientId: env.OIDC_CLIENT_ID || '', clientSecret: env.OIDC_CLIENT_SECRET || '', scope: env.OIDC_SCOPE || 'openid profile email', tokenAuth: env.OIDC_TOKEN_AUTH === 'post' ? 'post' : 'basic' };
  if (!issuer) return base;
  let d = discoCache.get(issuer);
  if (!d || d.exp < Date.now()) {
    const r = await fetch(`${issuer}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
    const j = await r.json();
    d = { authorize: j.authorization_endpoint, token: j.token_endpoint, jwks: j.jwks_uri, iss: j.issuer || issuer, exp: Date.now() + 3600e3 };
    discoCache.set(issuer, d);
  }
  return { ...base, issuer: d.iss, authorize: d.authorize, token: d.token, jwks: d.jwks };
}

const b64e = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const b64d = v => { const p = v.replace(/-/g, '+').replace(/_/g, '/'); const s = atob(p + '='.repeat((4 - (p.length % 4)) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); };
const encJson = v => b64e(new TextEncoder().encode(JSON.stringify(v)));
const decJson = v => JSON.parse(new TextDecoder().decode(b64d(v)));
const rand = n => b64e(crypto.getRandomValues(new Uint8Array(n)));
const hmacKey = secret => crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function sign(payload, secret) {
  const body = encJson(payload);
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${b64e(new Uint8Array(mac))}`;
}
export async function unsign(token, secret) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  try {
    const body = token.slice(0, dot);
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), b64d(token.slice(dot + 1)), new TextEncoder().encode(body)))) return null;
    const p = decJson(body);
    return p.exp && p.exp < Date.now() / 1000 ? null : p;
  } catch { return null; }
}
export function readCookie(req, name) {
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const secure = req => new URL(req.url).protocol === 'https:';
export const cookie = (name, value, maxAge, req) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;
function secretOf(env) { if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is not set'); return env.SESSION_SECRET; }
const redirectUri = (req, env) => env.OIDC_REDIRECT_URI || `${new URL(req.url).origin}/auth/callback`;

/**
 * Post-login `next` must be a same-origin path: starts with a single "/", no "//" anywhere at the start,
 * no backslash (browsers treat "\" like "/"), no control characters (tab/CR/LF are stripped by URL
 * parsers, so "/\t/evil.com" would become "//evil.com"), and no scheme-ish tricks.
 */
export function safeNext(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 2000) return '/'; // OAuth /authorize URLs can be long
  if (v[0] !== '/' || v.startsWith('//')) return '/';
  if (/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) return '/';
  try {
    const u = new URL(v, 'https://garage.invalid');
    if (u.origin !== 'https://garage.invalid') return '/';
    const out = u.pathname + u.search + u.hash;
    return out.startsWith('//') ? '/' : out; // "/.//evil.com" normalises to "//evil.com"
  } catch { return '/'; }
}
const plain = (text, status) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

const jwksCache = new Map();
async function jwks(uri, fresh) {
  const c = jwksCache.get(uri);
  if (!fresh && c && c.exp > Date.now()) return c.keys;
  const r = await fetch(uri, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`jwks fetch failed: ${r.status}`);
  const keys = (await r.json()).keys || [];
  jwksCache.set(uri, { keys, exp: Date.now() + 10 * 60e3 });
  return keys;
}
/** Verify a JWS (RS256 or ES256) against a JWKS URL; checks iss, aud, exp, iat. Returns the claims. */
export async function verifyJwt(token, { jwksUri, issuer, audience }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('token is not a JWS');
  const header = decJson(parts[0]), claims = decJson(parts[1]);
  if (!['RS256', 'ES256'].includes(header.alg)) throw new Error(`unexpected alg ${header.alg}`);
  let jwk = (await jwks(jwksUri)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await jwks(jwksUri, true)).find(k => k.kid === header.kid);
  if (!jwk) throw new Error(`no jwk for kid ${header.kid}`);
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let ok;
  if (header.alg === 'RS256') {
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64d(parts[2]), data);
  } else {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: jwk.crv || 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64d(parts[2]), data);
  }
  if (!ok) throw new Error('signature invalid');
  const now = Date.now() / 1000;
  if (claims.iss !== issuer) throw new Error('issuer mismatch');
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)) throw new Error('audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW < now) throw new Error('token expired');
  if (typeof claims.iat === 'number' && claims.iat - SKEW > now) throw new Error('token issued in the future');
  return claims;
}

export async function verifyIdToken(idToken, config, nonce) {
  const claims = await verifyJwt(idToken, { jwksUri: config.jwks, issuer: config.issuer, audience: config.clientId });
  if (claims.nonce !== nonce) throw new Error('nonce mismatch');
  if (!claims.sub) throw new Error('id_token has no sub');
  return claims;
}

/** 302 to the provider's sign-in page, with the flow parked in a signed cookie. */
export async function startLogin(req, env, next = '/') {
  const config = await oidcConfig(env);
  if (!config.clientId || !config.authorize) return plain('Sign-in is not set up yet (OIDC_ISSUER / OIDC_CLIENT_ID are unset).', 424);
  const verifier = rand(32), state = rand(16), nonce = rand(16);
  const challenge = b64e(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = new URL(config.authorize);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri(req, env), scope: config.scope, state, nonce, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(k, v);
  const flow = await sign({ state, verifier, nonce, next: safeNext(next), exp: Math.floor(Date.now() / 1000) + FLOW_TTL }, secretOf(env));
  return new Response(null, { status: 302, headers: { Location: url.toString(), 'Set-Cookie': cookie(FLOW_COOKIE, flow, FLOW_TTL, req), 'Cache-Control': 'no-store' } });
}

/** /auth/callback: returns { claims, next, clearFlow } on success, or a Response to send back as-is. */
export async function completeLogin(req, env) {
  const config = await oidcConfig(env), url = new URL(req.url);
  if (url.searchParams.get('error')) return plain(`Sign-in was cancelled or refused: ${url.searchParams.get('error')}. Go back and try again.`, 403);
  const flow = await unsign(readCookie(req, FLOW_COOKIE), secretOf(env));
  if (!flow) return plain('Sign-in expired. Go back and sign in again.', 400);
  const code = url.searchParams.get('code');
  if (!code) return plain('Missing authorization code.', 400);
  if (url.searchParams.get('state') !== flow.state) return plain('State mismatch.', 400);
  const iss = url.searchParams.get('iss');
  if (iss && iss !== config.issuer) return plain('Issuer mismatch on callback.', 400);
  const r = await fetch(config.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...(config.tokenAuth === 'basic' ? { Authorization: `Basic ${btoa(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`)}` } : {}) },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(req, env), code_verifier: flow.verifier, client_id: config.clientId, ...(config.tokenAuth === 'post' ? { client_secret: config.clientSecret } : {}) }),
  });
  if (!r.ok) return plain(`Token exchange failed (${r.status}): ${(await r.text()).slice(0, 300)}`, 424);
  const tokens = await r.json();
  if (!tokens.id_token) return plain('Token response carried no id_token.', 424);
  try { return { claims: await verifyIdToken(tokens.id_token, config, flow.nonce), next: safeNext(flow.next), clearFlow: cookie(FLOW_COOKIE, '', 0, req) }; }
  catch (err) { return plain(`Sign-in token rejected: ${err.message}`, 400); }
}
