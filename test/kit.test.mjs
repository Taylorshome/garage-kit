// Kit pieces: config -> wrangler, password hashing (Worker + script agree), VAPID JWT, add-car SQL, research-bundle
// safety, the research loader's plan on the demo bundle, research context selection on the demo research.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { buildWrangler, secretsFor } from '../scripts/configure.mjs';
import { hashPassword as nodeHash, vapidKeys } from '../scripts/secrets.mjs';
import { hashPassword, verifyPassword, authMode } from '../src/auth.js';
import { vapidJwt } from '../src/push.js';
import { carSql, STARTER } from '../scripts/add-car.mjs';
import { planLoad, categoryOf, matchPart } from '../scripts/load-research.mjs';
import { checkResearchShape, driftOf, saveResearchBundle } from '../src/research-bundle.js';
import { selectResearch } from '../src/research-context.js';
import { decodeVin } from '../src/api.js';

const example = JSON.parse(readFileSync(new URL('../garage.config.example.json', import.meta.url), 'utf8'));

function memDb() {
  const db = new DatabaseSync(':memory:');
  const MIG = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const prep = sql => {
    const st = db.prepare(sql);
    const bound = args => ({ first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }), run: async () => { const r = st.run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } });
    return { bind: (...a) => bound(a), ...bound([]) };
  };
  return { db, DB: { prepare: prep, batch: async s => Promise.all(s.map(x => x.run())) } };
}

test('configure: example config -> password mode, no integrations, no cron; validation catches missing ids', () => {
  const { wrangler, errors, secrets } = buildWrangler(example);
  assert.deepEqual(errors.filter(e => !/resources\./.test(e)), []);
  assert.equal(errors.filter(e => /resources\./.test(e)).length, 3, 'd1/kv ids are required for a real deploy');
  assert.equal(wrangler.vars.AUTH_MODE, 'password'); assert.equal(wrangler.vars.INTEGRATIONS, '');
  assert.equal(wrangler.triggers, undefined); assert.deepEqual(secrets, ['SESSION_SECRET', 'PASSWORD_HASH']);
  const local = buildWrangler(example, { local: true });
  assert.deepEqual(local.errors, []); assert.equal(local.wrangler.d1_databases[0].database_id, 'local-dev-only');
});

test('configure: integrations, auth modes and their secrets', () => {
  const c = structuredClone(example);
  Object.assign(c.resources, { d1_id: 'd', files_kv_id: 'f', oauth_kv_id: 'o' });
  c.auth.mode = 'oidc'; c.auth.oidc = { issuer: 'https://id.example.com', client_id: 'abc' };
  c.integrations.push = { enabled: true, public_key: 'BPUB' };
  c.integrations.home_assistant = { enabled: true, url: 'http://192.168.1.5:8123', notify_targets: ['mobile_app_x'] };
  c.integrations.research_worker = { enabled: true };
  let r = buildWrangler(c);
  assert.ok(r.errors.some(e => /home_assistant\.url/.test(e)), 'a LAN Home Assistant URL is refused');
  c.integrations.home_assistant.url = 'https://abc.ui.nabu.casa';
  r = buildWrangler(c);
  assert.deepEqual(r.errors, []);
  assert.equal(r.wrangler.vars.INTEGRATIONS, 'push,home_assistant,research_worker');
  assert.deepEqual(r.wrangler.triggers, { crons: ['0 * * * *'] });
  assert.deepEqual(r.secrets, ['SESSION_SECRET', 'OIDC_CLIENT_SECRET', 'VAPID_PRIVATE_KEY', 'HA_TOKEN', 'RESEARCH_WORKER_TOKEN']);
  assert.deepEqual(secretsFor('none', []), ['SESSION_SECRET']);
  c.auth.mode = 'bogus'; assert.ok(buildWrangler(c).errors.some(e => /auth\.mode/.test(e)));
  assert.equal(authMode({ AUTH_MODE: 'weird' }), 'password', 'unknown mode falls back to password, never to none');
});

test('password hashes: the setup script and the Worker agree; wrong passwords fail', async () => {
  const fromScript = nodeHash('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', fromScript), true);
  assert.equal(await verifyPassword('correct horse batterY', fromScript), false);
  const fromWorker = await hashPassword('another one');
  assert.equal(await verifyPassword('another one', fromWorker), true);
  assert.equal(await verifyPassword('x', ''), false); assert.equal(await verifyPassword('x', 'plain'), false);
});

test('VAPID: keys from the setup script sign an ES256 JWT the public key verifies', async () => {
  const k = vapidKeys();
  const env = { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey };
  const jwt = await vapidJwt(env, 'https://web.push.apple.com/abc', 'mailto:me@example.com');
  const [h, b, s] = jwt.split('.');
  const dec = x => JSON.parse(Buffer.from(x, 'base64url'));
  assert.equal(dec(h).alg, 'ES256'); assert.equal(dec(b).aud, 'https://web.push.apple.com'); assert.equal(dec(b).sub, 'mailto:me@example.com');
  const pub = await crypto.subtle.importKey('raw', Buffer.from(k.publicKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${b}`)), true);
});

test('add-car: SQL creates the car, starter schedule and symptom to-dos; bad input refused', () => {
  const { db } = memDb();
  const { id, sql } = carSql({ car: { nickname: "Mom's car", year: 2016, make: 'Mazda', model: 'CX-5', body_type: 'suv', color: '#334455', mileage: '81,200', vin: '1hgcm82633a004352' }, todos: [{ title: 'Rattle over bumps', symptom: true, priority: 'high' }] });
  db.exec(sql.join('\n'));
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(id);
  assert.equal(car.nickname, "Mom's car"); assert.equal(car.mileage, 81200); assert.equal(car.vin, '1HGCM82633A004352'); assert.equal(car.body_type, 'suv');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schedule_items WHERE car_id = ? AND source = 'starter'").get(id).n, STARTER.length);
  assert.equal(db.prepare("SELECT type FROM todos WHERE car_id = ?").get(id).type, 'symptom');
  assert.throws(() => carSql({ car: { nickname: 'x', body_type: 'tank' } }), /body_type/);
  assert.throws(() => carSql({ car: { nickname: 'x', vin: 'IIIIIIIIIIIIIIIII' } }), /vin/);
  assert.throws(() => carSql({ car: {} }), /nickname/);
});

test('loader: demo bundle plans new rows, replaces starter items, never touches items with history; re-load is refused without --force', async () => {
  const { db } = memDb();
  const { id, sql } = carSql(JSON.parse(readFileSync(new URL('../demo/demo-car.json', import.meta.url), 'utf8')), { id: 'car-demo' });
  db.exec(sql.join('\n'));
  db.exec("UPDATE schedule_items SET last_done_date = '2026-01-01', last_done_miles = 90000 WHERE car_id = 'car-demo' AND name = 'Oil & filter change'");
  db.exec("UPDATE schedule_items SET last_done_date = '2025-06-01' WHERE car_id = 'car-demo' AND name = 'Battery & terminals check'");
  const q = s => db.prepare(s).all();
  const dir = new URL('../demo/research/', import.meta.url).pathname;
  const { plan, sql: out } = planLoad({ car: { id, nickname: 'Demo Sedan' }, dir, opts: { schedule: true, todos: true }, q });
  assert.equal(plan.count('overwrite') + plan.count('delete') + plan.count('drift'), 0, 'first load is all new/update');
  const g = plan.gate({}, { log: () => {} }); assert.equal(g.write, true);
  db.exec(out.join('\n'));
  const items = db.prepare("SELECT name, source, last_done_date FROM schedule_items WHERE car_id = 'car-demo'").all();
  const oil = items.find(i => i.name === 'Oil & filter change' && i.source === 'manual');
  assert.equal(oil.last_done_date, '2026-01-01', 'last-done carried over to the researched oil item');
  assert.ok(items.find(i => i.name === 'Battery & terminals check' && i.source === 'user'), 'starter item with history is kept');
  assert.ok(!items.some(i => i.source === 'starter'), 'unused starter items are gone');
  assert.equal(JSON.parse(db.prepare("SELECT data FROM research WHERE car_id = 'car-demo'").get().data).tsbs[0].number, 'DEMO-TSB-01');
  assert.equal(JSON.parse(db.prepare("SELECT fluids FROM parts_guides WHERE car_id = 'car-demo'").get().fluids).length, 4);
  assert.equal(db.prepare("SELECT matched_part FROM brands WHERE car_id = 'car-demo'").get().matched_part, 'Oil filter');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM todos WHERE car_id = 'car-demo' AND source LIKE 'research:%'").get().n, 1);
  // second load of identical files: nothing to do
  const again = planLoad({ car: { id, nickname: 'Demo Sedan' }, dir, opts: { schedule: true, todos: true }, q });
  assert.equal(again.plan.items.filter(i => i[0] !== 'update').length, 0);
  // an entry added in D1 (save_research) = drift: refused even with --force
  const d = JSON.parse(db.prepare("SELECT data FROM research WHERE car_id = 'car-demo'").get().data);
  d.known_issues.push({ title: 'Added from claude.ai' });
  db.prepare("UPDATE research SET data = ? WHERE car_id = 'car-demo'").run(JSON.stringify(d));
  const p3 = planLoad({ car: { id, nickname: 'Demo Sedan' }, dir, opts: {}, q }).plan;
  assert.equal(p3.gate({ force: true }, { log: () => {} }).exit, 3);
  assert.equal(p3.gate({}, { log: () => {} }).exit, 3);
  assert.equal(p3.gate({ dry_run: true }, { log: () => {} }).exit, 0);
  assert.equal(p3.gate({ force: true, accept_drift: true }, { log: () => {} }).write, true);
});

test('loader helpers: categories and part matching', () => {
  assert.equal(categoryOf('Engine oil and filter'), 'oil'); assert.equal(categoryOf('Replace cabin air filter'), 'cabin');
  assert.equal(categoryOf('Brake fluid flush'), 'brakefluid'); assert.equal(categoryOf('Wash the car'), null);
  assert.equal(matchPart('Front brake pads (ceramic)', ['Oil filter', 'Front brake pads']), 'Front brake pads');
  assert.equal(matchPart('Spark plugs', ['Oil filter']), null);
});

test('save_research_bundle: new research saves; existing research needs overwrite; drift is reported', async () => {
  const { db, DB } = memDb();
  db.exec(readFileSync(new URL('./fixtures/garage.sql', import.meta.url), 'utf8'));
  const env = { DB };
  const car = { id: 'car-sedan', nickname: 'Sedan' };
  assert.throws(() => checkResearchShape({ recalls: 'none' }), /list/);
  let r = await saveResearchBundle(env, car, { research: { recalls: [{ campaign: 'A' }], questions: ['q1'] }, report_md: '# hi', fluids: [{ fluid: 'Oil', buy: '0W-20' }], dry_run: true });
  assert.equal(r.saved, false); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM research').get().n, 0);
  r = await saveResearchBundle(env, car, { research: { recalls: [{ campaign: 'A' }], questions: ['q1'] }, report_md: '# hi', fluids: [{ fluid: 'Oil', buy: '0W-20' }] });
  assert.equal(r.saved, true); assert.deepEqual(r.plan, ['research: new', 'parts_guides: new']);
  await assert.rejects(saveResearchBundle(env, car, { research: { recalls: [] } }), /overwrite=true/);
  r = await saveResearchBundle(env, car, { research: { recalls: [] }, overwrite: true, dry_run: true });
  assert.deepEqual(r.drift, ['recalls: a', 'questions: q1']);
  assert.deepEqual(driftOf({ tsbs: [{ number: 'X' }] }, { tsbs: [{ number: 'x' }] }), []);
});

test('research context: the demo research answers a brake question with the brake chunks', () => {
  const data = JSON.parse(readFileSync(new URL('../demo/research/research.json', import.meta.url), 'utf8'));
  const md = readFileSync(new URL('../demo/research/research.md', import.meta.url), 'utf8');
  const sel = selectResearch(data, md, { query: [{ text: 'my brakes squeal in the morning, what should I check?', weight: 1 }], openTodos: [], budget: 6000 });
  assert.match(sel.text, /DEMO-TSB-01/); assert.match(sel.text, /squeal/i);
  assert.ok(sel.text.length <= 6000 + 500);
});

test('VIN decode maps NHTSA vPIC fields and a body type', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.match(String(url), /vpic\.nhtsa\.dot\.gov\/api\/vehicles\/DecodeVinValues\/1HGCM82633A004352/);
    return new Response(JSON.stringify({ Results: [{ ModelYear: '2003', Make: 'HONDA', Model: 'Accord', Trim: 'EX', DisplacementL: '3.0', EngineConfiguration: 'V-Shaped', EngineCylinders: '6', BodyClass: 'Coupe', TransmissionSpeeds: '5', TransmissionStyle: 'Automatic', ErrorCode: '0' }] }));
  };
  try {
    const d = await decodeVin('1hgcm82633a004352');
    assert.equal(d.year, 2003); assert.equal(d.make, 'Honda'); assert.equal(d.model, 'Accord'); assert.equal(d.body_type, 'coupe');
    assert.equal(d.engine, '3.0L V6'); assert.equal(d.transmission, '5-speed Automatic'); assert.equal(d.error, null);
  } finally { globalThis.fetch = real; }
});
