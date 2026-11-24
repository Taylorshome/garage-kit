#!/usr/bin/env node
// Set the Worker secrets this setup needs, generating the ones that can be generated. Values are never printed.
//   npm run secrets                      remote (your Cloudflare account): SESSION_SECRET, VAPID keys, research token
//   npm run secrets -- --local           the same into .dev.vars for `wrangler dev`
//   npm run set-password [-- --local]    household password (prompted, not echoed) -> PASSWORD_HASH
//   npm run secrets -- --ha-token        prompt for the Home Assistant long-lived token -> HA_TOKEN
//   npm run secrets -- --oidc-secret     prompt for the OIDC client secret -> OIDC_CLIENT_SECRET
//   npm run secrets -- --rotate-research-token   new RESEARCH_WORKER_TOKEN (+ research-worker/token)
// Non-interactive (tests/CI): GARAGE_PASSWORD, GARAGE_HA_TOKEN, GARAGE_OIDC_SECRET env vars instead of prompts.
import { createECDH, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CONFIG_PATH, ROOT, flags, readConfig, wrangler } from './lib.mjs';
import { buildWrangler } from './configure.mjs';

const IS_MAIN = import.meta.url === `file://${process.argv[1]}`;
const opts = IS_MAIN ? flags(process.argv.slice(2), ['local', 'password', 'ha-token', 'ha-mileage-token', 'oidc-secret', 'rotate-research-token', 'force']) : {};
const DEV_VARS = join(ROOT, '.dev.vars');
const b64u = b => Buffer.from(b).toString('base64url');

export function hashPassword(pw, iter = 100000) {
  const salt = randomBytes(16);
  return `pbkdf2$${iter}$${salt.toString('base64')}$${pbkdf2Sync(pw, salt, iter, 32, 'sha256').toString('base64')}`;
}
export function vapidKeys() {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey(null, 'uncompressed')), privateKey: b64u(ecdh.getPrivateKey()) };
}

function readDevVars() {
  if (!existsSync(DEV_VARS)) return {};
  return Object.fromEntries(readFileSync(DEV_VARS, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
}
function writeDevVars(v) {
  writeFileSync(DEV_VARS, '# wrangler dev secrets (git-ignored). Written by scripts/secrets.mjs.\n' + Object.entries(v).map(([k, x]) => `${k}="${x}"`).join('\n') + '\n');
  chmodSync(DEV_VARS, 0o600);
}
function remoteNames() {
  try { return new Set(JSON.parse(wrangler(['secret', 'list', '--format', 'json'])).map(s => s.name)); }
  catch (e) { if (/not found|does not exist|10007/i.test(e.message)) return new Set(); throw e; }
}
function put(name, value, store) {
  if (opts.local) { store[name] = value; return; }
  wrangler(['secret', 'put', name], { input: value });
  console.log(`set ${name}`);
}

const interactive = () => !!process.stdin.isTTY;
async function ask(question, { hidden = false } = {}) {
  if (!interactive()) return null;   // run from an agent / CI: never hang on a prompt
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = s => { if (s.includes(question)) process.stdout.write(s); };
  const a = await new Promise(r => rl.question(question, r));
  rl.close(); if (hidden) process.stdout.write('\n');
  return a;
}

async function main() {
  const cfg = readConfig({ required: !opts.local }) || JSON.parse(readFileSync(join(ROOT, 'garage.config.example.json'), 'utf8'));
  const { secrets: needed } = buildWrangler(cfg, { local: !!opts.local });
  const have = opts.local ? new Set(Object.keys(readDevVars())) : remoteNames();
  const store = opts.local ? readDevVars() : null;
  const want = n => needed.includes(n) && (!have.has(n) || opts.force);

  if (opts.password || (want('PASSWORD_HASH') && !have.has('PASSWORD_HASH'))) {
    let pw = process.env.GARAGE_PASSWORD;
    if (!pw && !interactive()) {
      console.log('PASSWORD_HASH not set: the household password has to be typed by a person. Run `npm run set-password` in your own terminal.');
      if (opts.password) process.exit(1);
    } else if (!pw) {
      pw = await ask('Household password (8+ characters; everyone in the house uses it): ', { hidden: true });
      const again = await ask('Same password again: ', { hidden: true });
      if (pw !== again) { console.error('The two passwords differ; nothing changed.'); process.exit(1); }
    }
    if (pw != null) {
      if (pw.length < 8) { console.error('Use at least 8 characters.'); process.exit(1); }
      put('PASSWORD_HASH', hashPassword(pw), store);
    }
    if (opts.password && !opts.local) console.log('Password changed. Existing sign-ins stay valid until they expire (sign out on each device to force it).');
  }
  if (opts.password) { if (opts.local) writeDevVars(store); return; }

  if (want('SESSION_SECRET')) put('SESSION_SECRET', b64u(randomBytes(32)), store);
  if (want('VAPID_PRIVATE_KEY')) {
    const k = vapidKeys();
    put('VAPID_PRIVATE_KEY', k.privateKey, store);
    if (existsSync(CONFIG_PATH)) {
      const c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      c.integrations.push = { ...(c.integrations.push || {}), enabled: true, public_key: k.publicKey };
      writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
      console.log('VAPID public key saved in garage.config.json: run npm run configure (and deploy) so the app uses it.');
    } else writeFileSync(join(ROOT, '.vapid-public-key'), k.publicKey + '\n');
  }
  if (needed.includes('RESEARCH_WORKER_TOKEN') && (!have.has('RESEARCH_WORKER_TOKEN') || opts.rotate_research_token)) {
    const tok = b64u(randomBytes(32));
    put('RESEARCH_WORKER_TOKEN', tok, store);
    const f = join(ROOT, 'research-worker', opts.local ? 'token.local' : 'token');
    writeFileSync(f, tok + '\n'); chmodSync(f, 0o600);
    console.log(`research worker token written to ${f.replace(ROOT + '/', '')} (mode 600, git-ignored)`);
  }
  if ((opts.ha_token || want('HA_TOKEN'))) {
    const t = process.env.GARAGE_HA_TOKEN || await ask('Home Assistant long-lived access token (Profile -> Security): ', { hidden: true });
    if (t && t.trim()) put('HA_TOKEN', t.trim(), store); else console.log('HA_TOKEN not set: run `npm run secrets -- --ha-token` in your own terminal and paste it there.');
  }
  if (opts.ha_mileage_token) {     // Home Assistant mileage-reply automation (docs/integrations.md#home-assistant)
    const tok = b64u(randomBytes(32));
    put('HA_MILEAGE_TOKEN', tok, store);
    const f = join(ROOT, '.ha-mileage-token'); writeFileSync(f, tok + '\n'); chmodSync(f, 0o600);
    console.log('HA_MILEAGE_TOKEN set. Its value is in .ha-mileage-token (mode 600, git-ignored): in Home Assistant secrets.yaml add  garage_mileage_bearer: "Bearer <that value>"  (docs/integrations.md), then delete the file.');
  }
  if ((opts.oidc_secret || want('OIDC_CLIENT_SECRET'))) {
    const t = process.env.GARAGE_OIDC_SECRET || await ask('OIDC client secret: ', { hidden: true });
    if (t && t.trim()) put('OIDC_CLIENT_SECRET', t.trim(), store); else console.log('OIDC_CLIENT_SECRET not set: run `npm run secrets -- --oidc-secret` in your own terminal and paste it there.');
  }
  if (opts.local) { writeDevVars(store); console.log(`.dev.vars has: ${Object.keys(store).join(', ')}`); }
  if (opts.local) { const missing = needed.filter(n => !store[n]); if (missing.length) console.log(`still missing for local dev: ${missing.join(', ')}`); }
  else { const now = remoteNames(); const missing = needed.filter(n => !now.has(n)); console.log(missing.length ? `still missing on Cloudflare: ${missing.join(', ')}` : `all secrets set: ${needed.join(', ')}`); }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.message); process.exit(1); });
