#!/usr/bin/env node
// End-to-end check against a LOCAL `wrangler dev` (never your deployed garage): sign-in, add a car (VIN decode via the
// public NHTSA API), maintenance / due / catch-up / log, a symptom with the first-checks note (mock AI), the 3D model
// upload, and the MCP server with the full OAuth flow (DCR, PKCE, consent through the same sign-in) and its tools.
// Setup (see docs/development.md):
//   node scripts/configure.mjs --local --mock-ai && npx wrangler d1 migrations apply DB --local
//   GARAGE_PASSWORD=... node scripts/secrets.mjs --local && npx wrangler dev --port 8787
//   GARAGE_PASSWORD=... node scripts/e2e-local.mjs                 (password mode)
//   node scripts/e2e-local.mjs --none                              (after configure --local --mock-ai --mode=none)
// Env: E2E_BASE (default http://127.0.0.1:8787), GARAGE_PASSWORD, E2E_VIN (a real VIN to decode; default a public sample).
import { createHash, randomBytes } from 'node:crypto';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) { console.error('e2e-local only runs against a local wrangler dev (127.0.0.1 / localhost).'); process.exit(2); }
const NONE = process.argv.includes('--none');
const b64u = b => Buffer.from(b).toString('base64url');
const TRUCK = `MCP truck ${randomBytes(3).toString('hex')}`;   // unique per run
const results = []; const ok = (n, c, x = '') => { results.push(c); console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' :: ' + String(x).slice(0, 220) : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let cookie = '';
const J = { 'Content-Type': 'application/json', Origin: BASE };
const api = async (path, { method = 'GET', body, raw, headers = {} } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? J : raw ? { Origin: BASE, 'Content-Type': raw.type } : method !== 'GET' ? { Origin: BASE } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : raw?.data, redirect: 'manual' });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};

// ---------------------------------------------------------------- sign-in
if (!NONE) {
  let r = await api('/api/me'); ok('signed out: /api -> 401', r.status === 401);
  r = await fetch(BASE + '/', { redirect: 'manual' }); ok('signed out: / -> /auth/login', r.status === 302 && /^\/auth\/login\?next=/.test(r.headers.get('location')));
  r = await fetch(BASE + '/auth/login'); const page = await r.text();
  ok('login page (password + name)', r.status === 200 && /name="password"/.test(page) && /name="name"/.test(page));
  const login = pw => fetch(BASE + '/auth/login', { method: 'POST', redirect: 'manual', headers: { Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: pw, name: 'E2E Tester', next: '/#/settings' }) });
  r = await login('definitely wrong'); ok('wrong password refused', r.status === 401 && !r.headers.get('set-cookie'));
  r = await fetch(BASE + '/auth/login', { method: 'POST', redirect: 'manual', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=x' });
  ok('cross-origin login POST refused', r.status === 403);
  if (!process.env.GARAGE_PASSWORD) { console.error('set GARAGE_PASSWORD (the one given to secrets.mjs --local)'); process.exit(2); }
  r = await login(process.env.GARAGE_PASSWORD);
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  ok('right password -> session cookie + redirect', r.status === 303 && /^gr_session=/.test(cookie) && r.headers.get('location') === '/#/settings');
}
let r = await api('/api/me');
ok('/api/me + config', r.status === 200 && r.data.config.auth_mode === (NONE ? 'none' : 'password') && r.data.member.id === 'm-household', `${r.data.member?.name} ${JSON.stringify(r.data.config)}`);
if (!NONE) ok('session remembers the typed name', r.data.member.name === 'E2E Tester');
ok('disclaimer: not acknowledged yet for this person', r.data.disclaimer?.acked === false && /Not professional advice/.test(r.data.disclaimer.text));
r = await api('/api/disclaimer/ack', { method: 'POST', body: {} });
r = await api('/api/me'); ok('disclaimer: "I understand" is stored', r.data.disclaimer?.acked === true);
{ const page = await (await fetch(BASE + '/', { headers: cookie ? { Cookie: cookie } : {} })).text(); ok('disclaimer footer on the app page', /class="site-disclaimer[^>]*>Not professional advice/.test(page)); }
if (NONE) {
  const html = await (await fetch(BASE + '/')).text();
  ok('none mode: app served with no sign-in', /<main id="app">/.test(html));
}

// ---------------------------------------------------------------- add a car (the add-car flow: VIN decode -> car)
const vin = process.env.E2E_VIN || '1HGCM82633A004352';   // NHTSA's documentation sample VIN
r = await api(`/api/vin/${vin}`);
ok('VIN decode via NHTSA vPIC', r.status === 200 && r.data.make && r.data.year, `${r.data.year} ${r.data.make} ${r.data.model} ${r.data.engine} -> ${r.data.body_type}`);
const dec = r.status === 200 ? r.data : { year: 2003, make: 'Honda', model: 'Accord', body_type: 'coupe' };
r = await api('/api/cars', { method: 'POST', body: { nickname: `E2E car ${TRUCK.slice(-6)}`, year: dec.year, make: dec.make, model: dec.model, engine: dec.engine, body_type: dec.body_type, color: '#2a6f97', mileage: 120000, default_schedule: true } });
const carId = r.data.id; ok('add car with the starter schedule', r.status === 200 && !!carId);
r = await api(`/api/cars/${carId}`);
ok('car page data: starter items "typical, check your owner\'s manual"', r.data.items?.length === 12 && r.data.items.every(i => /owner's manual/.test(i.notes)), `${r.data.items?.length} items, health ${r.data.summary?.health}`);
r = await api('/api/cars/car-demo');
ok('demo car is there (seed-demo)', r.status === 200 && r.data.car.nickname === 'Demo Sedan', r.status);

// ---------------------------------------------------------------- maintenance, due, catch-up, log
r = await api('/api/due'); ok('due list', r.status === 200 && Array.isArray(r.data.items), `overdue ${r.data.counts?.overdue}, soon ${r.data.counts?.soon}, todos ${r.data.counts?.open_todos}`);
r = await api(`/api/cars/${carId}/catchup`);
const ci = r.data;
ok('catch-up lists items with no history', r.status === 200 && (ci.items || ci.pending || []).length >= 10, Object.keys(ci).join(','));
const list = ci.items || ci.pending;
const oilItem = list.find(i => /oil/i.test(i.name)), rotItem = list.find(i => /rotation/i.test(i.name)), plugs = list.find(i => /plug/i.test(i.name));
r = await api(`/api/cars/${carId}/catchup`, { method: 'POST', body: { mileage: 120500, answers: { [oilItem.id]: '6mo', [rotItem.id]: 'never', [plugs.id]: 'unknown' } } });
ok('catch-up saves (6 mo / never / don\'t remember)', r.status === 200, JSON.stringify(r.data).slice(0, 160));
r = await api(`/api/cars/${carId}`);
const it = id => r.data.items.find(i => i.id === id);
ok('catch-up: estimate set, "never" is due now, mileage updated', it(oilItem.id).last_done_estimated === 1 && it(rotItem.id).status === 'overdue' && r.data.car.mileage === 120500, `${it(oilItem.id).label} | ${it(rotItem.id).label}`);
r = await api(`/api/cars/${carId}/services`, { method: 'POST', body: { title: 'Tire rotation', date: new Date().toISOString().slice(0, 10), mileage: 120600, item_ids: [rotItem.id], diy: true } });
ok('quick log a service', r.status === 200, JSON.stringify(r.data).slice(0, 100));
r = await api(`/api/cars/${carId}`);
ok('logged item is done: status ok, mileage bumped', it(rotItem.id).status === 'ok' && r.data.car.mileage === 120600 && r.data.services.length === 1, it(rotItem.id).label);

// ---------------------------------------------------------------- symptom -> first checks (mock AI) + research queue
r = await api(`/api/cars/${carId}/symptoms`, { method: 'POST', body: { description: 'Clunk from the front left over bumps', kind: ['noise'], when: ['bumps'], where: ['front', 'left'] } });
const symId = r.data.id;
ok('add a symptom (queued for research)', r.status === 200 && r.data.research === 'queued', JSON.stringify(r.data));
let note = null;
for (let i = 0; i < 20 && !note; i++) { await sleep(500); const t = await api(`/api/todos/${symId}`); if (t.data.todo?.ai_status === 'done' || t.data.ai_status === 'done') note = t.data.todo?.ai_note || t.data.ai_note; }
ok('first-checks note written (mock AI)', /AI mock/.test(note || ''), (note || '').slice(0, 60));
r = await api('/api/research/queue');
ok('research queue shows it', r.data.queue?.some(q => q.todo_id === symId), r.data.queue?.length);

// ---------------------------------------------------------------- your own .glb
const glb = Buffer.alloc(64); glb.write('glTF', 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(64, 8);
r = await api(`/api/cars/${carId}/model`, { method: 'POST', raw: { type: 'model/gltf-binary', data: glb } });
ok('upload .glb', r.status === 200 && r.data.size === 64);
r = await api(`/api/cars/${carId}`); const murl = r.data.car.model_url;
r = await fetch(BASE + murl, { headers: cookie ? { Cookie: cookie } : {} });
ok('model_url serves it', r.status === 200 && r.headers.get('content-type') === 'model/gltf-binary');
r = await api(`/api/cars/${carId}/model`, { method: 'POST', raw: { type: 'model/gltf-binary', data: Buffer.from('not a model at all, sorry') } });
ok('non-glb refused', r.status === 415);
r = await api(`/api/cars/${carId}/model`, { method: 'DELETE' }); ok('remove .glb', r.status === 200);

// ---------------------------------------------------------------- MCP + OAuth
r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
ok('unauthenticated /mcp -> 401 + resource metadata', r.status === 401 && /resource_metadata=/.test(r.headers.get('www-authenticate') || ''));
const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json().catch(() => ({}));
ok('protected resource metadata', prm.resource === `${BASE}/mcp`, JSON.stringify(prm).slice(0, 120));
const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
ok('authorization server metadata', asm.authorization_endpoint === `${BASE}/authorize` && asm.code_challenge_methods_supported?.includes('S256'));
const redirect = 'http://127.0.0.1:33418/callback';
const reg = await (await fetch(asm.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'garage-e2e-test', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
ok('dynamic client registration', !!reg.client_id);
const verifier = b64u(randomBytes(32)), challenge = b64u(createHash('sha256').update(verifier).digest()), state = b64u(randomBytes(12));
const authUrl = `${BASE}/authorize?` + new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, scope: 'garage', state, code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` });
if (!NONE) {
  r = await fetch(authUrl, { redirect: 'manual' });
  const loc = r.headers.get('location') || '';
  ok('signed-out /authorize -> the password page', r.status === 302 && loc.startsWith('/auth/login?next=%2Fauthorize'));
  const lp = await (await fetch(BASE + loc)).text();
  ok('...which is the household password form', /name="password"/.test(lp));
}
r = await fetch(authUrl, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
const html = await r.text();
const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
ok('consent page', r.status === 200 && /Connect garage-e2e-test\?/.test(html) && !!handle, r.status);
if (NONE) ok('none mode: consent page warns', /no sign-in/i.test(html));
const form = new URLSearchParams({ handle, decision: 'approve' });
for (const sc of [...html.matchAll(/name="scope" value="([^"]+)"/g)].map(m => m[1])) form.append('scope', sc);
const consentCookie = (r.headers.get('set-cookie') || '').split(';')[0];
r = await fetch(`${BASE}/authorize`, { method: 'POST', redirect: 'manual', headers: { Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: [cookie, consentCookie].filter(Boolean).join('; ') }, body: form });
const cb = new URL(r.headers.get('location') || 'http://x/');
ok('approve -> code + state', !!cb.searchParams.get('code') && cb.searchParams.get('state') === state, r.status);
const tok = await (await fetch(asm.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code'), redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })).json();
ok('token exchange (PKCE)', !!tok.access_token && !!tok.refresh_token, `expires_in=${tok.expires_in}`);
let rid = 0;
const rpc = async (method, params) => (await (await fetch(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) })).json());
const tool = async (name, args = {}) => { const j = await rpc('tools/call', { name, arguments: args }); if (j.result?.isError || j.error) throw new Error(`${name}: ${j.result?.content?.[0]?.text || JSON.stringify(j.error)}`); return j.result.structuredContent; };
const T = async (label, fn) => { try { const [c, x] = await fn(); ok(label, c, x); } catch (e) { ok(label, false, e.message); } };
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
ok('MCP initialize (instructions name the cars)', init.result?.serverInfo?.name === 'garage' && /Demo Sedan/.test(init.result.instructions), init.result?.serverInfo?.title);
ok('MCP instructions carry the disclaimer (once per conversation)', /once per conversation[^\n]*Not professional advice/.test(init.result.instructions));
const tl = await rpc('tools/list', {});
const names = tl.result.tools.map(t => t.name);
ok('tools/list', ['start_diagnosis', 'record_check_result', 'finish_diagnosis', 'add_car', 'decode_vin', 'save_symptom_report', 'list_research_requests', 'save_research_bundle', 'update_schedule_item', 'add_receipt', 'confirm_receipt', 'get_due_list', 'save_research'].every(n => names.includes(n)), `${names.length} tools`);
await T('list_cars', async () => { const c = await tool('list_cars'); return [c.cars.length >= 2, c.cars.map(x => x.nickname).join(', ')]; });
await T('get_car fuzzy ("demo")', async () => { const c = await tool('get_car', { car: 'demo' }); return [c.nickname === 'Demo Sedan' && c.fluids.length === 4, `${c.open_todos.length} open`]; });
await T('get_research (known issues with phase)', async () => { const x = await tool('get_research', { car: 'Demo Sedan', section: 'known_issues' }); return [x.known_issues.length === 2 && x.known_issues.every(k => k.phase), x.known_issues.map(k => k.phase).join('/')]; });
await T('get_parts / get_alternates / get_shopping_list', async () => { const p = await tool('get_parts', { car: 'demo' }); const a = await tool('get_alternates', { car: 'demo' }); const s = await tool('get_shopping_list', { car: 'demo' }); return [p.parts.length === 3 && a.parts.length >= 1 && !!s, `${p.parts.length} parts`]; });
await T('get_due_list', async () => { const d = await tool('get_due_list'); return [Array.isArray(d.maintenance), `${d.maintenance.length} due, ${d.todos.length} todos`]; });
await T('decode_vin', async () => { const d = await tool('decode_vin', { vin }); return [!!d.make, `${d.year} ${d.make} ${d.model}`]; });
let mcpCar;
await T('add_car (MCP)', async () => { const c = await tool('add_car', { nickname: TRUCK, year: 2010, make: 'Ford', model: 'Ranger', body_type: 'pickup', color: '#3b5e2b', mileage: 150000 }); mcpCar = c.id; return [!!c.id, c.note]; });
await T('update_schedule_item adds and changes', async () => { const a = await tool('update_schedule_item', { car: TRUCK, name: 'Rear differential fluid', interval_miles: 30000, source: 'manual', notes: '75W-90, per the manual' }); const b = await tool('update_schedule_item', { car: TRUCK, name: 'rear differential fluid', interval_miles: 50000 }); return [a.added && b.updated, 'added + updated']; });
await T('add_symptom (dedupe)', async () => { const a = await tool('add_symptom', { car: TRUCK, description: 'Whine from the back at highway speed', when: 'highway' }); const b = await tool('add_symptom', { car: TRUCK, description: 'whine from the back at highway speed' }); return [!a.duplicate && b.duplicate, a.research]; });
let reqs;
await T('list_research_requests', async () => { reqs = (await tool('list_research_requests')).requests; return [reqs.length >= 2, reqs.map(q => q.title).join(' | ')]; });
await T('save_symptom_report', async () => {
  const q = reqs.find(x => /Whine/.test(x.title));
  const s = await tool('save_symptom_report', { todo_id: q.todo_id, report: { summary: 'Most likely a worn rear differential pinion bearing; check the fluid level and condition first.', likely_causes: [{ cause: 'Low or old differential fluid', likelihood: 'high', why: 'cheap first', how_to_check: 'pull the fill plug', fix: 'refill', diy_difficulty: 2, cost_diy: '$30', cost_shop: '$120' }], check_order: ['Check the fluid level'], safe_to_drive: { verdict: 'caution', why: 'watch for heat' }, parts: [], videos: [], sources: [{ title: 'test source', url: 'https://example.com/e2e' }], questions_for_owner: [] } });
  const left = (await tool('list_research_requests')).requests.filter(x => x.todo_id === q.todo_id);
  return [s.ok && left.length === 0, `job ${s.job_id?.slice(0, 8)}`];
});
await T('save_symptom_report refuses a report without sources', async () => { const j = await rpc('tools/call', { name: 'save_symptom_report', arguments: { todo_id: reqs[0].todo_id, report: { summary: 'Too thin of a report to accept, no sources at all here.', likely_causes: [{ cause: 'x' }], safe_to_drive: { verdict: 'yes' }, sources: [] } } }); return [j.result?.isError === true, j.result?.content?.[0]?.text]; });
await T('save_research_bundle (new, then overwrite refused, dry run shows drift)', async () => {
  const a = await tool('save_research_bundle', { car: TRUCK, research: { recalls: [{ campaign: 'TEST-1', summary: 'test' }], known_issues: [{ title: 'Test issue' }] }, report_md: '# Test', fluids: [{ fluid: 'Engine oil', buy: '5W-20', amount: '6 qt' }] });
  const b = await rpc('tools/call', { name: 'save_research_bundle', arguments: { car: TRUCK, research: { recalls: [] } } });
  const c = await tool('save_research_bundle', { car: TRUCK, research: { recalls: [] }, overwrite: true, dry_run: true });
  return [a.saved && b.result.isError && c.drift.length === 2, c.drift.join('; ')];
});
await T('save_research adds entries', async () => { const x = await tool('save_research', { car: TRUCK, section: 'questions', entries: ['Which axle ratio?'] }); return [x.saved && x.added.length === 1, x.total_after]; });
await T('guided diagnosis: start -> answer -> found -> finish (history) -> fix to-do after yes', async () => {
  let v = await tool('start_diagnosis', { car: 'demo', symptom: 'brakes squeal' });
  const sid = v.session_id;
  const j0 = await rpc('tools/call', { name: 'get_diagnosis', arguments: { session: sid } });
  if (!/Not professional advice/.test(v.disclaimer || '')) throw new Error('start_diagnosis has no disclaimer');
  v = await tool('record_check_result', { session: sid, result: 'squeals all day' });
  v = await tool('record_check_result', { session: sid, result: '2' });
  const found = v.outcome === 'found';
  v = await tool('finish_diagnosis', { session: sid });
  const fix = await tool('finish_diagnosis', { session: sid, create_fix_todo: true });
  const list = await tool('list_diagnoses', { car: 'demo' });
  return [found && v.status === 'found' && !!v.service_id && fix.fix_todo_created && list.sessions?.[0]?.status === 'found', v.conclusion];
});
await T('log_service marks schedule items done', async () => { const x = await tool('log_service', { car: TRUCK, date: new Date().toISOString().slice(0, 10), mileage: 150200, title: 'Oil change', schedule_items: ['oil'] }); return [x.marked_done === 1, JSON.stringify(x).slice(0, 80)]; });
await T('update_mileage', async () => { const x = await tool('update_mileage', { car: TRUCK, mileage: 150500 }); return [x.mileage === 150500, x.mileage]; });
await T('add_receipt (fields) -> confirm_receipt', async () => {
  const a = await tool('add_receipt', { car: TRUCK, date: new Date().toISOString().slice(0, 10), mileage: 150600, shop: `Test Lube ${TRUCK.slice(-6)}`, total: 54.1, tax: 3.1, line_items: [{ description: 'Synthetic oil change 5W-20', amount: 51 }], schedule_items: ['oil'], transcription: `TEST LUBE ${TRUCK} oil change 51.00 tax 3.10 total 54.10` });
  const c = await tool('confirm_receipt', { id: a.id });
  const again = await tool('confirm_receipt', { id: a.id });
  return [a.status === 'pending' && c.service_id && again.already_saved, a.summary];
});
await T('get_history', async () => { const x = await tool('get_history', { car: TRUCK, query: 'oil' }); return [x.services.length >= 2, x.services.map(s => s.title).join(', ')]; });
r = await api('/api/connections');
const grant = r.data.grants?.find(g => g.client === 'garage-e2e-test');
ok('Settings lists the connected app', !!grant);
r = await api(`/api/connections/${grant?.id}`, { method: 'DELETE' });
ok('disconnect from Settings', r.status === 200, r.status);
const after = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":9,"method":"tools/list"}' });
ok('Disconnect -> the token stops working at once', after.status === 401, after.status);

// ---------------------------------------------------------------- research worker endpoints stay closed without the token
r = await fetch(`${BASE}/api/research-jobs/next`, { headers: { Authorization: 'Bearer nope' } });
ok('research worker endpoint needs its token', r.status === 401);
r = await fetch(`${BASE}/api/ha/mileage`, { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{}' });
ok('HA mileage reply endpoint needs its token', r.status === 401);
r = await fetch(`${BASE}/api/health/alert`, { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{}' });
ok('health alert endpoint needs the worker token', r.status === 401);

// cleanup of the test cars (local DB anyway)
for (const id of [carId, mcpCar].filter(Boolean)) await api(`/api/cars/${id}`, { method: 'DELETE' });
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
