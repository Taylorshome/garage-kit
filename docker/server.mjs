#!/usr/bin/env node
// Garage in a container: the same Worker code as the Cloudflare deploy, run by workerd (Cloudflare's open-source
// Workers runtime) through Miniflare's API. Data lives in /data:
//   /data/state/      D1 (SQLite) and KV, persisted by Miniflare
//   /data/backups/    automatic copies of state/ taken before new migrations run
//   /data/secrets.json generated session key, VAPID keys, research-worker token (0600)
// This Node process owns the public port and forwards to workerd on 127.0.0.1. It adds what Cloudflare gives a
// deployed Worker for free: migrations on start, the hourly cron, an outbound SSRF filter, client IP / proxy
// handling, IMAP email-in, /healthz and a graceful shutdown.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Log, LogLevel, Miniflare, Response as MfResponse, convertV4MiniflareOptions } from 'miniflare';
import { buildConfig, ensureDir } from './config.mjs';
import { applyMigrations, migrationStatus } from './migrate.mjs';
import { outboundHandler } from './outbound.mjs';
import { returnPath, startImap } from './imap.mjs';
import { startAdmin } from './admin.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || '/data';
const VERSION = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')).version;
const COMPAT_DATE = '2026-10-06';
const log = { log: (...a) => console.log(new Date().toISOString(), ...a), warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a), error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a) };

function fatal(msg) { log.error(msg); process.exit(1); }

// ---------------------------------------------------------------- startup checks
try {
  ensureDir(DATA);
  accessSync(DATA, constants.W_OK);
  const probe = join(DATA, `.write-test-${process.pid}`); writeFileSync(probe, 'ok'); unlinkSync(probe);
} catch (e) {
  fatal(`${DATA} is not writable by uid ${process.getuid?.()} (${e.code || e.message}). Fix the folder's owner on the host, e.g. \`sudo chown -R ${process.getuid?.()}:${process.getgid?.()} /path/to/garage-data\`, or run the container with --user matching the folder's owner.`);
}

let cfg;
try { cfg = await buildConfig(process.env, { dataDir: DATA, version: VERSION }); }
catch (e) { fatal(e.message); }
for (const w of cfg.warnings) log.warn(w);
if (cfg.errors.length) fatal(`configuration problems:\n- ${cfg.errors.join('\n- ')}`);
const S = cfg.settings;
const INTERNAL_TOKEN = randomBytes(32).toString('base64url');
const STATE = ensureDir(join(DATA, 'state'));
const BACKUPS = ensureDir(join(DATA, 'backups'));
const WORKER = join(APP, 'dist', 'worker', 'docker.js');
if (!existsSync(WORKER)) fatal(`${WORKER} is missing (the image build bundles it with \`wrangler deploy --dry-run\`)`);

// ---------------------------------------------------------------- Miniflare / workerd
function mfOptions() {
  return convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0,
    cf: false, telemetry: { enabled: false }, logRequests: false, unsafeLocalExplorer: false,   // no calls home, no dev tooling
    log: new Log(S.logLevel === 'debug' ? LogLevel.DEBUG : LogLevel.WARN),
    resourcePersistencePath: STATE,
    workers: [{
      name: 'garage',
      modules: true, scriptPath: WORKER,
      compatibilityDate: COMPAT_DATE, compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],   // plus outbound.mjs: no private addresses
      bindings: { ...cfg.bindings, INTERNAL_TOKEN },
      d1Databases: { DB: 'garage' },
      kvNamespaces: { FILES: 'files', OAUTH_KV: 'oauth' },
      ratelimits: { MCP_LIMITER: { namespace_id: '1201', simple: { limit: 120, period: 60 } }, LOGIN_LIMITER: { namespace_id: '1202', simple: { limit: 10, period: 60 } } },
      assets: { directory: join(APP, 'public'), binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } },
      outboundService: outboundHandler({ allowHosts: S.allowHosts, ResponseCtor: MfResponse, log }),
    }],
  });
}

let mf = null;
async function startMiniflare() { mf = new Miniflare(mfOptions()); await mf.ready; return mf; }

function backupState(reason) {
  ensureDir(BACKUPS);
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}`.replace(/[^\w.-]/g, '_');
  cpSync(STATE, join(BACKUPS, name), { recursive: true });
  const all = readdirSync(BACKUPS).filter(d => /-before-/.test(d)).sort();   // only these automatic copies; manual dumps stay
  for (const old of all.slice(0, Math.max(0, all.length - Math.max(1, S.backupsKeep)))) rmSync(join(BACKUPS, old), { recursive: true, force: true });
  return join(BACKUPS, name);
}

await startMiniflare();
{
  const dir = join(APP, 'migrations');
  const st = await migrationStatus(await mf.getD1Database('DB'), dir);
  if (st.pending.length && !st.fresh) {
    // upgrade: copy the data while workerd is stopped (a consistent snapshot), then migrate
    await mf.dispose();
    const where = backupState(`before-${st.pending[0].replace(/\.sql$/, '')}`);
    log.log(`backup of /data/state before ${st.pending.length} new migration(s): ${where}`);
    await startMiniflare();
  }
  try { await applyMigrations(await mf.getD1Database('DB'), dir, { log: log.log }); }
  catch (e) { fatal(`migration failed: ${e.message}. Nothing after the failing file was applied; the backup is in ${BACKUPS}.`); }
}

// ---------------------------------------------------------------- HTTP front door
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length', 'expect']);
const STRIP = /^(cf-(?!access-jwt-assertion)|x-forwarded-|x-real-ip|forwarded$|mf-|x-garage-internal)/i;
const publicHost = S.publicUrl ? new URL(S.publicUrl).host.toLowerCase() : null;
const publicHttps = S.publicUrl.startsWith('https://');
let inflight = 0, closing = false;

const first = v => String(Array.isArray(v) ? v[0] : v || '').split(',')[0].trim();
function clientIp(req) {
  if (S.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff.at(-1);
    if (req.headers['x-real-ip']) return first(req.headers['x-real-ip']);
  }
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

async function internal(path, init = {}, timeoutMs = 5000) {
  return mf.dispatchFetch(`http://garage.internal${path}`, { ...init, headers: { ...(init.headers || {}), 'X-Garage-Internal': INTERNAL_TOKEN }, signal: AbortSignal.timeout(timeoutMs) });
}

async function handle(req, res) {
  const raw = req.url || '/';
  if (!raw.startsWith('/')) { res.writeHead(400).end(); return; }
  const pathname = raw.split('?')[0];
  if (pathname === '/healthz') {
    try { const r = await internal('/__garage/health'); const j = await r.json(); res.writeHead(r.ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: !!j.ok && !closing })); }
    catch { res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"ok":false}'); }
    return;
  }
  if (pathname.startsWith('/__garage/') || pathname.startsWith('/cdn-cgi/')) { res.writeHead(404).end(); return; }
  if (Number(req.headers['content-length'] || 0) > S.maxBodyMb * 1048576) { res.writeHead(413, { 'Content-Type': 'text/plain' }).end('Too large'); return; }

  let proto = 'http', host = String(req.headers.host || `127.0.0.1:${S.port}`);
  if (S.trustProxy) {
    const xfp = first(req.headers['x-forwarded-proto']).toLowerCase(), xfh = first(req.headers['x-forwarded-host']);
    if (xfp === 'https' || xfp === 'http') proto = xfp;
    if (xfh) host = xfh;
  }
  // a request for the PUBLIC_URL host came through its TLS terminator, even if the proxy sent no X-Forwarded-Proto
  if (publicHttps && host.toLowerCase() === publicHost) proto = 'https';
  if (!/^[\w.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(host)) { res.writeHead(400).end('Bad Host'); return; }

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || STRIP.test(k)) continue;
    for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
  }
  headers.set('CF-Connecting-IP', clientIp(req));
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  const r = await mf.dispatchFetch(`${proto}://${host}${raw}`, { method: req.method, headers, body: hasBody ? req : undefined, duplex: 'half', redirect: 'manual', signal: ac.signal });
  const out = {};
  for (const [k, v] of r.headers) { if (k === 'set-cookie' || k === 'content-length' || k === 'transfer-encoding') continue; out[k] = v; }
  const cookies = r.headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies;
  res.writeHead(r.status, r.statusText || undefined, out);
  if (!r.body || req.method === 'HEAD') { res.end(); return; }
  for await (const chunk of r.body) { if (!res.write(chunk)) await new Promise(ok => res.once('drain', ok)); }
  res.end();
}

const server = createServer((req, res) => {
  if (closing) { res.writeHead(503, { Connection: 'close', 'Retry-After': '5' }).end('Restarting'); return; }
  inflight++;
  handle(req, res).catch(e => {
    if (e.name !== 'AbortError') log.error(`request ${req.method} ${String(req.url).split('?')[0]} failed: ${e.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end('Bad gateway'); else res.destroy();
  }).finally(() => { inflight--; });
});
server.requestTimeout = 0;          // mechanic answers stream for minutes
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;
server.on('error', e => fatal(`can't listen on ${S.host}:${S.port}: ${e.code || e.message}`));
server.listen(S.port, S.host, () => log.log(`garage-kit ${VERSION} listening on ${S.host}:${S.port} (auth ${cfg.vars.AUTH_MODE}, AI ${cfg.vars.AI_PROVIDER}, integrations: ${cfg.vars.INTEGRATIONS || 'none'}${S.publicUrl ? `, public ${S.publicUrl}` : ''})`));

// one raw message -> the Worker's email() handler (IMAP poller, and `garage email-in` for testing)
async function deliverEmail(raw, { from }) {
  const q = new URLSearchParams({ from: from || returnPath(Buffer.from(raw)), to: cfg.vars.MAIL_ADDRESS || '' });
  const r = await internal(`/__garage/email?${q}`, { method: 'POST', body: raw, headers: { 'Content-Type': 'message/rfc822' } }, 600_000);
  if (!r.ok) throw new Error(`worker returned ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------- admin port for the kit's scripts (inside the container only)
const adminServer = startAdmin({ port: Number(process.env.ADMIN_PORT || 8788), tokenFile: join(DATA, '.admin-token'), getDb: () => mf.getD1Database('DB'), runScheduled: () => runCron(new Date()), deliverEmail, log });

// ---------------------------------------------------------------- hourly cron (same as the Cloudflare trigger "0 * * * *")
let cronTimer = null;
async function runCron(when) {
  try { const w = await mf.getWorker(); const r = await w.scheduled({ cron: '0 * * * *', scheduledTime: when }); if (r?.outcome && r.outcome !== 'ok') log.warn(`scheduled run: ${r.outcome}`); return r; }
  catch (e) { log.error(`scheduled run failed: ${e.message}`); return { outcome: 'exception', error: e.message }; }
}
function scheduleCron() {
  const now = Date.now(), next = Math.ceil((now + 1000) / 3600_000) * 3600_000;
  cronTimer = setTimeout(async () => { await runCron(new Date(next)); if (!closing) scheduleCron(); }, next - now);
}
if (S.cron) scheduleCron();

// ---------------------------------------------------------------- IMAP email-in
const imap = S.imap ? startImap(S.imap, { log, deliver: deliverEmail }) : null;

// ---------------------------------------------------------------- graceful shutdown
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  log.log(`${sig}: shutting down (waiting for ${inflight} request(s))`);
  clearTimeout(cronTimer);
  server.close();
  adminServer.close();
  await imap?.stop();
  const deadline = Date.now() + 20_000;
  while (inflight > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
  server.closeAllConnections?.();
  try { await mf.dispose(); } catch (e) { log.warn(`dispose: ${e.message}`); }
  log.log('stopped');
  process.stdout.write('', () => process.exit(0));
}
// Miniflare's bundled signal-exit re-raises SIGTERM when it counts its own listeners as the only ones, killing the
// process before a graceful stop. We dispose workerd ourselves, so ours are the only signal handlers.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.removeAllListeners(sig);
  process.on(sig, () => shutdown(sig));
}
