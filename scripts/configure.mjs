#!/usr/bin/env node
// garage.config.json -> wrangler.jsonc (both git-ignored). Run after every config change: `npm run configure`.
// --local   no config needed: writes a wrangler.jsonc for `wrangler dev` only (placeholder ids, password auth, no integrations)
// --check   validate garage.config.json and print what it would write, without writing
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_PATH, WRANGLER_PATH, flags } from './lib.mjs';

const IS_MAIN = import.meta.url === `file://${process.argv[1]}`;
const opts = IS_MAIN ? flags(process.argv.slice(2), ['local', 'check', 'mock-ai', 'mode']) : {};
const MODES = ['password', 'none', 'cloudflare-access', 'oidc'];
const PLACEHOLDER = 'local-dev-only';
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function buildWrangler(c, { local = false, mockAi = false } = {}) {
  const errors = [];
  const name = String(c.worker_name || 'garage');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) errors.push('worker_name: lowercase letters, digits and dashes');
  const mode = c.auth?.mode || 'password';
  if (!MODES.includes(mode)) errors.push(`auth.mode must be one of ${MODES.join(', ')}`);
  const tz = c.timezone || 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { errors.push(`timezone "${tz}" is not an IANA zone like America/Chicago`); }
  const r = c.resources || {};
  if (!local) {
    if (!r.d1_id) errors.push('resources.d1_id is empty (npx wrangler d1 create garage)');
    if (!r.files_kv_id) errors.push('resources.files_kv_id is empty (npx wrangler kv namespace create garage-files)');
    if (!r.oauth_kv_id) errors.push('resources.oauth_kv_id is empty (npx wrangler kv namespace create garage-oauth)');
  }
  const I = c.integrations || {};
  const on = k => !!(I[k] && (I[k] === true || I[k].enabled));
  const ints = ['push', 'email', 'home_assistant', 'research_worker'].filter(on);
  const vars = {
    APP_NAME: String(c.app_name || 'Garage').slice(0, 40),
    AUTH_MODE: mode,
    TIMEZONE: tz,
    INTEGRATIONS: ints.join(','),
    NOTIFY_HOUR: String(Number.isInteger(c.notify_hour) ? c.notify_hour : 8),
    MILEAGE_CHECK: c.mileage_check === false ? 'off' : 'on',
    GLB_MAX_MB: String(c.glb_max_mb || 15),
    APP_VERSION: PKG_VERSION,
  };
  if (c.my_tools) vars.OWNER_TOOLS = String(c.my_tools).slice(0, 400);
  if (c.domain?.custom_domain) vars.APP_ORIGIN = `https://${c.domain.custom_domain}`;
  const ai = c.ai || {};
  if (ai.chat_model) vars.AI_CHAT_MODEL = ai.chat_model;
  if (ai.chat_fallback) vars.AI_CHAT_FALLBACK = ai.chat_fallback;
  if (ai.fast_model) vars.AI_FAST_MODEL = ai.fast_model;
  if (ai.vision_model) vars.AI_VISION_MODEL = ai.vision_model;
  if (ai.vision_fallback) vars.AI_VISION_FALLBACK = ai.vision_fallback;
  if (mode === 'cloudflare-access') {
    if (!c.auth.access?.team_domain || !c.auth.access?.aud) errors.push('auth.access.team_domain and auth.access.aud are required for cloudflare-access');
    vars.ACCESS_TEAM_DOMAIN = c.auth.access?.team_domain || ''; vars.ACCESS_AUD = c.auth.access?.aud || '';
  }
  if (mode === 'oidc') {
    if (!c.auth.oidc?.issuer || !c.auth.oidc?.client_id) errors.push('auth.oidc.issuer and auth.oidc.client_id are required for oidc');
    vars.OIDC_ISSUER = c.auth.oidc?.issuer || ''; vars.OIDC_CLIENT_ID = c.auth.oidc?.client_id || '';
    if (c.auth.oidc?.token_auth === 'post') vars.OIDC_TOKEN_AUTH = 'post';
  }
  if (on('push')) {
    let pub = I.push.public_key || '';
    if (!pub && existsSync('.vapid-public-key')) pub = readFileSync('.vapid-public-key', 'utf8').trim();
    if (!pub) errors.push('integrations.push needs a VAPID key: run npm run gen-vapid');
    vars.VAPID_PUBLIC_KEY = pub;
    if (I.push.subject) vars.VAPID_SUBJECT = I.push.subject;
  }
  if (on('email')) {
    if (!I.email.address) errors.push('integrations.email.address is required (e.g. garage@yourdomain.com)');
    vars.MAIL_ADDRESS = I.email.address || '';
    if ((I.email.notify_to || []).length) vars.NOTIFY_EMAIL_TO = I.email.notify_to.join(',');
  }
  if (on('home_assistant')) {
    if (!/^https:\/\//.test(I.home_assistant.url || '')) errors.push('integrations.home_assistant.url must be an https:// address reachable from the internet (Nabu Casa or a Cloudflare Tunnel)');
    vars.HA_URL = I.home_assistant.url || '';
    vars.HA_NOTIFY_TARGETS = (I.home_assistant.notify_targets || []).join(',');
  }
  const w = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name,
    main: 'src/index.js',
    compatibility_date: '2026-10-06',
    compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
    ...(c.account_id && !local ? { account_id: c.account_id } : {}),
    workers_dev: local ? true : c.domain?.workers_dev !== false,
    preview_urls: false,
    ...(c.domain?.custom_domain && !local ? { routes: [{ pattern: c.domain.custom_domain, custom_domain: true }] } : {}),
    observability: { enabled: true },
    assets: { directory: './public', binding: 'ASSETS', run_worker_first: true },
    vars,
    d1_databases: [{ binding: 'DB', database_name: r.d1_name || 'garage', database_id: r.d1_id || PLACEHOLDER, migrations_dir: 'migrations' }],
    kv_namespaces: [{ binding: 'FILES', id: r.files_kv_id || PLACEHOLDER }, { binding: 'OAUTH_KV', id: r.oauth_kv_id || `${PLACEHOLDER}-oauth` }],
    ratelimits: [
      { name: 'MCP_LIMITER', namespace_id: '1201', simple: { limit: 120, period: 60 } },
      { name: 'LOGIN_LIMITER', namespace_id: '1202', simple: { limit: 10, period: 60 } },
    ],
    ...(mockAi ? {} : { ai: { binding: 'AI' } }),
  };
  if (mockAi) w.vars.AI_MOCK = '1';
  if (ints.some(k => ['push', 'email', 'home_assistant', 'research_worker'].includes(k))) w.triggers = { crons: ['0 * * * *'] };
  if (on('email') && (I.email.notify_to || []).length) w.send_email = [{ name: 'NOTIFY_EMAIL', allowed_destination_addresses: I.email.notify_to }];
  return { wrangler: w, errors, secrets: secretsFor(mode, ints) };
}

export function secretsFor(mode, ints) {
  const s = ['SESSION_SECRET'];
  if (mode === 'password') s.push('PASSWORD_HASH');
  if (mode === 'oidc') s.push('OIDC_CLIENT_SECRET');
  if (ints.includes('push')) s.push('VAPID_PRIVATE_KEY');
  if (ints.includes('home_assistant')) s.push('HA_TOKEN');
  if (ints.includes('research_worker')) s.push('RESEARCH_WORKER_TOKEN');
  return s;
}

function render(w) {
  return `// GENERATED by scripts/configure.mjs from garage.config.json. Edit that file and re-run \`npm run configure\`.\n${JSON.stringify(w, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let cfg;
  if (opts.local && !existsSync(CONFIG_PATH)) cfg = JSON.parse(readFileSync(new URL('../garage.config.example.json', import.meta.url), 'utf8'));
  else if (!existsSync(CONFIG_PATH)) { console.error('garage.config.json not found. Copy garage.config.example.json (or run the setup-garage skill), or use --local for wrangler dev.'); process.exit(1); }
  else cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (opts.local && typeof opts.mode === 'string') cfg.auth = { ...(cfg.auth || {}), mode: opts.mode };   // e.g. --mode=none for testing
  const { wrangler, errors, secrets } = buildWrangler(cfg, { local: !!opts.local, mockAi: !!opts.mock_ai });
  if (errors.length) { console.error('garage.config.json problems:\n- ' + errors.join('\n- ')); if (!opts.local) process.exit(1); }
  if (opts.check) { console.log(render(wrangler)); console.log(`Secrets this setup needs: ${secrets.join(', ')}`); process.exit(0); }
  writeFileSync(WRANGLER_PATH, render(wrangler));
  console.log(`wrote wrangler.jsonc (${wrangler.vars.AUTH_MODE} sign-in, integrations: ${wrangler.vars.INTEGRATIONS || 'none'})`);
  console.log(`Secrets this setup needs: ${secrets.join(', ')}  (npm run secrets sets the generated ones)`);
}
