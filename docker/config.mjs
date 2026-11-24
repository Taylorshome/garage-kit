// Container configuration: environment variables (and Docker secrets via *_FILE) -> the Worker's vars/secrets.
// Generated secrets (session key, VAPID keys, research-worker token) live in /data/secrets.json so restarts and
// upgrades don't log anyone out or break push subscriptions. Nothing here ever logs a secret value.
import { randomBytes, webcrypto, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET_NAMES = ['GARAGE_PASSWORD', 'PASSWORD_HASH', 'SESSION_SECRET', 'OIDC_CLIENT_SECRET', 'AI_API_KEY', 'ANTHROPIC_API_KEY',
  'CF_API_TOKEN', 'HA_TOKEN', 'HA_POLL_TOKEN', 'HA_MILEAGE_TOKEN', 'RESEARCH_WORKER_TOKEN', 'IMAP_PASS', 'VAPID_PRIVATE_KEY'];

/** process.env with NAME_FILE (Docker / compose secrets) resolved. A _FILE that can't be read is a startup error. */
export function readEnv(src = process.env) {
  const env = { ...src };
  for (const [k, v] of Object.entries(src)) {
    if (!k.endsWith('_FILE') || !v) continue;
    const name = k.slice(0, -5);
    try { env[name] = readFileSync(v, 'utf8').replace(/\r?\n$/, ''); }
    catch (e) { throw new Error(`${k}: can't read ${v} (${e.code || e.message})`); }
  }
  return env;
}

const b64u = buf => Buffer.from(buf).toString('base64url');

/** P-256 VAPID key pair: public = uncompressed point (65 bytes), private = d; both base64url (same as scripts/secrets.mjs). */
export function vapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')])), privateKey: jwk.d };
}

/** Same format as src/auth.js hashPassword: pbkdf2$<iter>$<salt b64>$<hash b64>. */
export async function hashPassword(password, iter = 100000) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${Buffer.from(salt).toString('base64')}$${Buffer.from(bits).toString('base64')}`;
}

/** /data/secrets.json: create what's missing, keep what's there (0600). */
export function persistedSecrets(dataDir, need) {
  const file = join(dataDir, 'secrets.json');
  let s = {};
  if (existsSync(file)) { try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON; fix or remove it (removing it signs everyone out and resets push)`); } }
  let changed = false;
  const add = (k, make) => { if (!s[k]) { s[k] = make(); changed = true; } };
  add('SESSION_SECRET', () => b64u(randomBytes(32)));
  if (need.vapid) { if (!s.VAPID_PUBLIC_KEY || !s.VAPID_PRIVATE_KEY) { Object.assign(s, (k => ({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey }))(vapidKeys())); changed = true; } }
  if (need.researchToken) add('RESEARCH_WORKER_TOKEN', () => b64u(randomBytes(32)));
  if (changed) { writeFileSync(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); try { chmodSync(file, 0o600); } catch { /* not ours to chmod */ } }
  return s;
}

const truthy = v => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const hostOf = u => { try { return new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return null; } };

/** Provider defaults: Workers AI model names only make sense for Workers AI. */
function aiModels(env, provider) {
  const out = {};
  const set = (k, v) => { if (env[k]) out[k] = env[k]; else if (v) out[k] = v; };
  if (provider === 'anthropic') {
    set('AI_CHAT_MODEL', 'claude-opus-5-5'); set('AI_CHAT_FALLBACK', 'claude-sonnet-5-5'); set('AI_FAST_MODEL', 'claude-haiku-5-5');
    set('AI_VISION_MODEL', 'claude-opus-5-5'); set('AI_VISION_FALLBACK', 'claude-sonnet-5-5');
  } else if (provider === 'openai-compatible') {
    const chat = env.AI_CHAT_MODEL;
    set('AI_CHAT_MODEL'); set('AI_CHAT_FALLBACK', chat); set('AI_FAST_MODEL', chat);
    const vision = env.AI_VISION_MODEL || chat;
    set('AI_VISION_MODEL', vision); set('AI_VISION_FALLBACK', vision);
  } else for (const k of ['AI_CHAT_MODEL', 'AI_CHAT_FALLBACK', 'AI_FAST_MODEL', 'AI_VISION_MODEL', 'AI_VISION_FALLBACK']) set(k);
  return out;
}

/**
 * Build everything the server needs from the environment. Returns { bindings, settings, warnings }.
 * bindings = the Worker's env (vars + secrets); settings = what only the Node side uses (port, proxy, IMAP...).
 */
export async function buildConfig(rawEnv, { dataDir = '/data', version = '0.0.0' } = {}) {
  const env = readEnv(rawEnv);
  const errors = [], warnings = [];
  const publicUrl = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (publicUrl && !/^https?:\/\/[^/]+$/.test(publicUrl)) errors.push('PUBLIC_URL must be an origin like https://garage.example.com (no path)');
  const authModeRaw = String(env.AUTH_MODE || 'password').toLowerCase();
  if (!['password', 'none', 'oidc', 'cloudflare-access'].includes(authModeRaw)) errors.push('AUTH_MODE must be password, none, oidc or cloudflare-access');
  const tz = env.TZ || env.TIMEZONE || 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { errors.push(`TZ "${tz}" is not an IANA zone like America/Chicago`); }

  const provider = String(env.AI_PROVIDER || 'none').toLowerCase().replace(/^(openai|ollama)$/, 'openai-compatible');
  if (!['cloudflare-rest', 'openai-compatible', 'anthropic', 'none', 'mock'].includes(provider)) errors.push('AI_PROVIDER must be cloudflare-rest, openai-compatible, anthropic, none (or mock for tests)');
  if (provider === 'openai-compatible' && !env.AI_BASE_URL) errors.push('AI_PROVIDER=openai-compatible needs AI_BASE_URL (e.g. http://ollama:11434/v1)');
  if (provider === 'openai-compatible' && !env.AI_CHAT_MODEL) errors.push('AI_PROVIDER=openai-compatible needs AI_CHAT_MODEL (e.g. qwen3:14b)');
  if (provider === 'anthropic' && !(env.ANTHROPIC_API_KEY || env.AI_API_KEY)) errors.push('AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
  if (provider === 'cloudflare-rest' && !(env.CF_ACCOUNT_ID && env.CF_API_TOKEN)) errors.push('AI_PROVIDER=cloudflare-rest needs CF_ACCOUNT_ID and CF_API_TOKEN');

  // integrations: explicit INTEGRATIONS wins; otherwise switched on by their settings
  const imap = env.IMAP_HOST ? { host: env.IMAP_HOST, port: Number(env.IMAP_PORT || 993), secure: env.IMAP_TLS === undefined ? Number(env.IMAP_PORT || 993) === 993 : truthy(env.IMAP_TLS),
    user: env.IMAP_USER || '', pass: env.IMAP_PASS || '', folder: env.IMAP_FOLDER || 'INBOX', processedFolder: env.IMAP_PROCESSED_FOLDER || '', pollSec: Math.max(30, Number(env.IMAP_POLL_SECONDS || 120)) } : null;
  if (imap && (!imap.user || !imap.pass)) errors.push('IMAP_HOST is set: IMAP_USER and IMAP_PASS are needed too');
  const auto = [];
  if (publicUrl.startsWith('https://') || env.VAPID_PUBLIC_KEY) auto.push('push');
  if (imap) auto.push('email');
  if (env.HA_URL && env.HA_TOKEN) auto.push('home_assistant');
  if (truthy(env.RESEARCH_WORKER)) auto.push('research_worker');
  const ints = env.INTEGRATIONS !== undefined ? String(env.INTEGRATIONS).split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : auto;
  if (ints.includes('email') && !imap) warnings.push('INTEGRATIONS has email but IMAP_HOST is not set: nothing will arrive (Docker uses IMAP polling for email-in)');

  const gen = persistedSecrets(dataDir, { vapid: ints.includes('push') && !env.VAPID_PRIVATE_KEY, researchToken: ints.includes('research_worker') && !env.RESEARCH_WORKER_TOKEN });

  let passwordHash = env.PASSWORD_HASH || '';
  if (authModeRaw === 'password' && !passwordHash) {
    if (env.GARAGE_PASSWORD) {
      if (env.GARAGE_PASSWORD.length < 8) warnings.push('GARAGE_PASSWORD is shorter than 8 characters');
      passwordHash = await hashPassword(env.GARAGE_PASSWORD);
    } else warnings.push('AUTH_MODE=password but neither GARAGE_PASSWORD nor PASSWORD_HASH is set: nobody can sign in');
  }
  if (authModeRaw === 'none') warnings.push('AUTH_MODE=none: anyone who can reach this garage can read and change everything');
  if (authModeRaw === 'oidc' && !(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET)) errors.push('AUTH_MODE=oidc needs OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET');
  if (authModeRaw === 'cloudflare-access' && !(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD)) errors.push('AUTH_MODE=cloudflare-access needs ACCESS_TEAM_DOMAIN and ACCESS_AUD');
  if (!publicUrl) warnings.push('PUBLIC_URL is not set: Claude connectors (MCP) and phone notifications need a public https address');

  const mailAddress = env.MAIL_ADDRESS || (imap && /@/.test(imap.user) ? imap.user : '');
  const vars = {
    GARAGE_RUNTIME: 'docker', APP_VERSION: version,
    APP_NAME: String(env.APP_NAME || 'Garage').slice(0, 40), AUTH_MODE: authModeRaw, TIMEZONE: tz,
    INTEGRATIONS: ints.join(','), NOTIFY_HOUR: String(env.NOTIFY_HOUR ?? 8), MILEAGE_CHECK: env.MILEAGE_CHECK || 'on',
    GLB_MAX_MB: String(env.GLB_MAX_MB || 15), AI_PROVIDER: provider, ...aiModels(env, provider),
  };
  const copy = ['OWNER_TOOLS', 'AI_BASE_URL', 'AI_SEND_REASONING_EFFORT', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_SERVER_FALLBACK', 'CF_ACCOUNT_ID', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_SCOPE',
    'OIDC_TOKEN_AUTH', 'OIDC_REDIRECT_URI', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'HA_URL', 'HA_NOTIFY_TARGETS', 'VAPID_SUBJECT', 'NOTIFY_EMAIL_TO'];
  for (const k of copy) if (env[k]) vars[k] = String(env[k]);
  if (publicUrl) vars.APP_ORIGIN = publicUrl;
  if (mailAddress) vars.MAIL_ADDRESS = mailAddress;
  if (provider === 'mock') vars.AI_MOCK = '1';
  const secrets = {
    SESSION_SECRET: env.SESSION_SECRET || gen.SESSION_SECRET,
    ...(passwordHash ? { PASSWORD_HASH: passwordHash } : {}),
  };
  for (const k of ['OIDC_CLIENT_SECRET', 'AI_API_KEY', 'ANTHROPIC_API_KEY', 'CF_API_TOKEN', 'HA_TOKEN', 'HA_POLL_TOKEN', 'HA_MILEAGE_TOKEN']) if (env[k]) secrets[k] = env[k];
  if (ints.includes('push')) { vars.VAPID_PUBLIC_KEY = env.VAPID_PUBLIC_KEY || gen.VAPID_PUBLIC_KEY; secrets.VAPID_PRIVATE_KEY = env.VAPID_PRIVATE_KEY || gen.VAPID_PRIVATE_KEY; }
  if (ints.includes('research_worker') || env.RESEARCH_WORKER_TOKEN) secrets.RESEARCH_WORKER_TOKEN = env.RESEARCH_WORKER_TOKEN || gen.RESEARCH_WORKER_TOKEN;

  // Outbound allowlist: LAN/private addresses the app may reach (everything else private is blocked, see outbound.mjs)
  const allowHosts = new Set();
  for (const u of [env.AI_BASE_URL, env.HA_URL, env.OIDC_ISSUER, env.ANTHROPIC_BASE_URL]) { const h = u && hostOf(u); if (h) allowHosts.add(h); }
  for (const h of String(env.OUTBOUND_ALLOW_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) allowHosts.add(h.replace(/:\d+$/, ''));

  const settings = {
    port: Number(env.PORT || 8787), host: env.HOST || '0.0.0.0', dataDir, publicUrl,
    trustProxy: truthy(env.TRUST_PROXY), maxBodyMb: Number(env.MAX_UPLOAD_MB || 60),
    cron: env.CRON !== 'off', imap, allowHosts, backupsKeep: Number(env.BACKUPS_KEEP || 10), logLevel: env.LOG_LEVEL || 'info',
  };
  return { bindings: { ...vars, ...secrets }, vars, secretNames: Object.keys(secrets), settings, errors, warnings };
}

export function ensureDir(p) { mkdirSync(p, { recursive: true }); return p; }
