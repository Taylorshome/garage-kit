// Garage Worker: the site + JSON API behind the configured sign-in (src/auth.js), the MCP server for Claude
// (OAuth 2.1, /mcp), the optional email() handler (email-in), the optional research-worker endpoints, and an hourly
// scheduled() run for reminders. Configuration comes from garage.config.json via scripts/configure.mjs -> wrangler.jsonc.
import { OAuthProvider, AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { authMode, currentMember, handleAuth } from './auth.js';
import { dueList, handleApi } from './api.js';
import { handleEmail, setEmailOrigin } from './email.js';
import { handleMcp } from './mcp.js';
import { setDiagOrigin, setOwnerTools } from './diagnosis.js';
import { STALE_SEC, claimNext, submitResult } from './research-jobs.js';
import { configureVisionModels, setAppOrigin } from './receipts.js';
import { configureChatModels } from './ai.js';
import { mockAi } from './ai-mock.js';
import { enabled, haNotify, notify, setNotifyOrigin } from './notify.js';
import { applyMileageReply } from './mileage.js';
import { deliverReceiptNotices, runScheduled } from './scheduled.js';
import { HttpError, esc, json, page, randomToken, safeEqual, setTimezone } from './util.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", // three.js vendored in public/vendor; wasm for the meshopt decoder (vendored)
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
// home-screen icon, manifest and the push service worker are public: iOS fetches them without the session cookie
const PUBLIC_ASSETS = new Set(['/styles.css', '/favicon.svg', '/robots.txt', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/sw.js']);
// Raw-body uploads (the only writes that aren't JSON)
const UPLOAD_RE = /^\/api\/(services\/[\w-]+\/files|todos\/[\w-]+\/files|diagnoses\/[\w-]+\/photos|cars\/[\w-]+\/(scans|photos|model)|receipts)$/;   // /api/receipts: multipart

/** Per-request configuration from env (vars come from garage.config.json). */
export function configure(env, origin) {
  if (!env.AI && env.AI_MOCK === '1') env.AI = mockAi;      // local e2e only (see src/ai-mock.js)
  setTimezone(env.TIMEZONE || 'UTC');
  configureChatModels(env);
  configureVisionModels(env);
  const o = (env.APP_ORIGIN || origin || '').replace(/\/$/, '');
  setAppOrigin(o); setEmailOrigin(o); setNotifyOrigin(o); setDiagOrigin(o); setOwnerTools(env.OWNER_TOOLS);
  return o;
}

function withHeaders(res, url) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  if (url?.protocol === 'https:') h.set('Strict-Transport-Security', 'max-age=31536000');
  if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', CSP);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function checkWrite(req, env, url) {
  const origin = req.headers.get('Origin');
  const allowed = [env.APP_ORIGIN, url.origin].filter(Boolean);
  if (!origin || !allowed.includes(origin)) throw new HttpError(403, 'Cross-origin request refused');
  if (url.pathname.startsWith('/api/') && !UPLOAD_RE.test(url.pathname)) {
    const ct = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (req.method !== 'DELETE' && ct !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  }
}
const bearer = req => (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();

/** Read-only status: D1 works, mechanic answer failures (last 24 h), research queue. */
async function health(env) {
  const since = Math.floor(Date.now() / 1000) - 86400;
  try {
    const [cars, ai, jobs] = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS n FROM cars WHERE archived = 0'),
      env.DB.prepare('SELECT outcome, COUNT(*) AS n FROM ai_failures WHERE at > ?1 GROUP BY outcome').bind(since),
      env.DB.prepare(`SELECT SUM(status = 'queued') AS queued, SUM(status = 'running') AS running, SUM(status = 'running' AND started_at < ?1) AS stuck FROM research_jobs`)
        .bind(Math.floor(Date.now() / 1000) - STALE_SEC),
    ]);
    const by = Object.fromEntries(ai.results.map(r => [r.outcome, r.n]));
    const j = jobs.results[0] || {};
    return { ok: true, db: true, version: env.APP_VERSION || null, cars: cars.results[0].n, time: new Date().toISOString(),
      ai: { failed: by.failed || 0, truncated: by.truncated || 0, recovered: by.recovered || 0 },
      research: { queued: j.queued || 0, running: j.running || 0, stuck: j.stuck || 0 } };
  } catch (e) {
    console.error('health: D1 failed', e.message);
    return { ok: false, db: false, version: env.APP_VERSION || null, error: String(e.message).slice(0, 200) };
  }
}

function manifest(env) {
  const name = String(env.APP_NAME || 'Garage').slice(0, 40);
  return new Response(JSON.stringify({
    name, short_name: name.slice(0, 12), description: 'Car maintenance, symptoms, parts and an AI mechanic', start_url: '/', scope: '/', display: 'standalone',
    background_color: '#0b0d10', theme_color: '#0b0d10',
    icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
  }), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' } });
}

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname;
  // Optional background research worker (research-worker/ on your always-on computer): per-install bearer token only
  if (path === '/api/research-jobs/next' || /^\/api\/research-jobs\/[\w-]+\/result$/.test(path)) {
    if (!env.RESEARCH_WORKER_TOKEN || !safeEqual(bearer(req), env.RESEARCH_WORKER_TOKEN)) return json({ error: 'bad token' }, 401);
    if (path === '/api/research-jobs/next' && req.method === 'GET') {
      const job = await claimNext(env);
      return job ? json({ ...job, url: `${(env.APP_ORIGIN || url.origin)}/${job.url}` }) : new Response(null, { status: 204 });
    }
    if (req.method === 'POST' && path.endsWith('/result')) {
      const body = await req.json().catch(() => null);
      if (!body) return json({ error: 'JSON body required' }, 400);
      return json(await submitResult(env, path.split('/')[3], body));
    }
    return json({ error: 'not found' }, 404);
  }
  // Health alert from research-worker/health-check.py on your always-on computer (bearer RESEARCH_WORKER_TOKEN)
  if (path === '/api/health/alert' && req.method === 'POST') {
    if (!env.RESEARCH_WORKER_TOKEN || !safeEqual(bearer(req), env.RESEARCH_WORKER_TOKEN)) return json({ error: 'bad token' }, 401);
    const b = await req.json().catch(() => ({}));
    return json(await notify(env, { kind: 'health', title: String(b.title || 'Garage health').slice(0, 120), body: String(b.body || '').slice(0, 400), url: '#/settings' }));
  }
  // Monthly mileage check reply from Home Assistant (an HA automation + rest_command; bearer HA_MILEAGE_TOKEN)
  if (path === '/api/ha/mileage') {
    if (!env.HA_MILEAGE_TOKEN || !safeEqual(bearer(req), env.HA_MILEAGE_TOKEN)) return json({ error: 'bad token' }, 401);
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'JSON body required' }, 400);
    const carId = String(body.car_id || body.action || '').replace(/^GARAGE_MI_/, '');
    const out = await applyMileageReply(env, { ...body, car_id: carId });
    if (enabled(env, 'home_assistant') && !body.dry_run) await haNotify(env, { title: `${env.APP_NAME || 'Garage'}: ${out.car}`, message: out.saved ? `Saved ${out.mileage.toLocaleString('en-US')} mi.` : `Not saved: ${out.reason}. Try again or use the app.` }).catch(() => {});
    return json(out);
  }
  // Read-only bearer endpoints for Home Assistant (REST sensor) and monitoring: HA_POLL_TOKEN
  if ((path === '/api/health' || path === '/api/due') && req.method === 'GET' && (req.headers.get('Authorization') || '').startsWith('Bearer ')) {
    const tok = bearer(req);
    const ok = (env.HA_POLL_TOKEN && safeEqual(tok, env.HA_POLL_TOKEN)) || (path === '/api/health' && env.RESEARCH_WORKER_TOKEN && safeEqual(tok, env.RESEARCH_WORKER_TOKEN));
    if (!ok) return json({ error: 'bad token' }, 401);
    if (path === '/api/due') return json(await dueList(env));
    const h = await health(env);
    return json(h, h.ok ? 200 : 424);
  }
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (isWrite) checkWrite(req, env, url);

  if (path.startsWith('/auth/')) {
    const r = await handleAuth(req, env, url);
    if (r) return r;
  }
  if (path === '/authorize') return authorize(req, env, url);
  if (path === '/signed-out') return page('Signed out', '<p>You are signed out of the garage.</p><p><a class="btn" href="/auth/login">Sign in again</a></p>');
  if (path === '/manifest.webmanifest') return manifest(env);
  if (PUBLIC_ASSETS.has(path)) {
    const res = await env.ASSETS.fetch(req);
    if (path === '/sw.js') { const h = new Headers(res.headers); h.set('Cache-Control', 'no-cache'); h.set('Service-Worker-Allowed', '/'); return new Response(res.body, { status: res.status, headers: h }); }
    return res;
  }

  const member = await currentMember(req, env);
  if (!member) {
    if (path.startsWith('/api/')) return json({ error: 'Sign in required' }, 401);
    if (authMode(env) === 'cloudflare-access') return page('Cloudflare Access required', '<p>This garage is protected by Cloudflare Access, but this request did not carry a valid Access token. Open it through the Access-protected address.</p>', 403);
    const next = path + url.search;
    return new Response(null, { status: 302, headers: { Location: `/auth/login?next=${encodeURIComponent(next)}`, 'Cache-Control': 'no-store' } });
  }

  if (path.startsWith('/api/')) return handleApi(req, env, ctx, url, member);

  const res = await env.ASSETS.fetch(req);
  const h = new Headers(res.headers);
  h.set('Cache-Control', 'private, no-cache');
  if (res.status === 404 && !path.includes('.')) return env.ASSETS.fetch(new Request(`${url.origin}/index.html`, req));
  return new Response(res.body, { status: res.status, headers: h });
}

// ---------- OAuth /authorize for MCP clients: the normal sign-in (whatever the auth mode), then consent ----------
async function authorize(req, env, url) {
  const oauth = env.OAUTH_PROVIDER;
  const member = await currentMember(req, env);
  const app = env.APP_NAME || 'Garage';
  try {
    if (req.method === 'GET') {
      if (!member) return new Response(null, { status: 302, headers: { Location: `/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store' } });
      const request = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      const origin = details.clientDomain ? `Published by <strong>${esc(details.clientDomain)}</strong>.` : 'This app registered itself; its name is not verified.';
      const noAuth = authMode(env) === 'none' ? '<p class="form-error"><strong>Warning: this garage has no sign-in.</strong> Anyone who knows its address can connect an app like this one.</p>' : '';
      const res = page(`Connect ${details.clientName}?`, `${noAuth}<p><strong>${esc(details.clientName)}</strong> wants to read ${esc(app)} (cars, schedules, research, history) and add symptoms, to-dos, services, receipts and mileage as <strong>${esc(member.name)}</strong>. ${origin} Access goes to <strong>${esc(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
<form method="post"><input type="hidden" name="handle" value="${esc(consent.handle)}">
${details.scope.map(sc => `<input type="hidden" name="scope" value="${esc(sc)}">`).join('')}
<p style="display:flex;gap:8px"><button class="btn primary" name="decision" value="approve">Allow</button><button class="btn" name="decision" value="deny">Deny</button></p></form>
<p class="small muted">You can disconnect it any time in Settings → Connected Claude apps.</p>`);
      for (const [k, v] of consent.headers) res.headers.append(k, v);
      return res;
    }
    if (req.method === 'POST') {
      if (!member) return page('Signed out', '<p>Sign in again and restart the connection from your app.</p>', 401);
      const form = await req.formData();
      const handle = String(form.get('handle') || '');
      if (form.get('decision') !== 'approve') { const denied = await oauth.denyConsent(req, handle); return new Response(null, { status: 302, headers: denied.headers }); }
      const approved = await oauth.approveConsent(req, handle, { scope: form.getAll('scope').map(String) });
      const client = await oauth.lookupClient(approved.request.clientId);
      const clientName = (client?.clientName || 'Claude').slice(0, 40);
      const nonce = randomToken(12);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request, userId: member.id, metadata: { client: clientName, member: member.name, nonce },
        scope: approved.request.scope, props: { member_id: member.id, name: member.name, client: clientName, grant: nonce },
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response('Method not allowed', { status: 405 });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) return page('Cannot connect', `<p>${esc(e instanceof AuthorizationError ? e.description : 'This app could not be verified.')}</p>`, 400);
    throw e;
  }
}

async function app(req, env, ctx) {
  const url = new URL(req.url);
  try { return withHeaders(await route(req, env, ctx), url); }
  catch (e) {
    if (e instanceof HttpError) return withHeaders(json({ error: e.message }, e.status), url);
    console.error('unhandled', e.stack || e);
    // 4xx on purpose: a zone in front may replace 5xx bodies with an error page
    return withHeaders(json({ error: `Server error: ${e.message}` }, 424), url);
  }
}

// OAuth 2.1 authorization server for MCP clients (DCR, PKCE, tokens in KV). The resource URL depends on the origin
// (APP_ORIGIN, else the request's own origin: workers.dev, a custom domain, or http://localhost in wrangler dev).
const providers = new Map();
function providerFor(origin, appName) {
  if (!providers.has(origin)) {
    providers.set(origin, new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler: { fetch: (req, env, ctx) => handleMcp(req, env, ctx).then(r => withHeaders(r, new URL(req.url))) },
      defaultHandler: { fetch: app },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['garage', 'offline_access'],
      requiredScopes: ['garage'],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: `${appName} MCP` },
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 3600,
      refreshTokenTTL: 90 * 86400,
    }));
  }
  return providers.get(origin);
}

export default {
  fetch(req, env, ctx) {
    const origin = configure(env, new URL(req.url).origin);
    return providerFor(origin, String(env.APP_NAME || 'Garage').slice(0, 40)).fetch(req, env, ctx);
  },
  async email(message, env, ctx) {
    configure(env, '');
    if (!enabled(env, 'email')) { message.setReject('Email-in is not enabled for this garage'); return; }
    try { await handleEmail(message, env, ctx); }
    catch (e) { console.error('email handler failed', e.stack || e); }
    try { await deliverReceiptNotices(env); } catch (e) { console.warn('receipt notice failed', e.message); }
  },
  async scheduled(event, env, ctx) {
    configure(env, '');
    ctx.waitUntil(runScheduled(env, new Date(event.scheduledTime)).catch(e => console.error('scheduled failed', e.stack || e)));
  },
};
