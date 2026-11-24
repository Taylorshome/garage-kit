// Receipts: validation, dedupe, schedule matching, email kind detection, the robust model wrapper, and the
// create -> confirm flow against a real SQLite copy of the schema (D1 shim) with a fake Workers AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeDraft, validateDraft, matchItems, todoCandidates, emailKind, parseDate, filesHash, textHash, robustExtract, mergeDrafts,
  createReceipt, confirmReceipt, discardReceipt, listPending, chosenItems, draftSummary, receiptView, unnotified, markNotified,
} from '../src/receipts.js';
import { createService } from '../src/api.js';
import { resolveCar } from '../src/ops.js';

const cars = [
  { id: 'car-minivan', nickname: 'Minivan', year: 2014, make: 'Honda', model: 'Odyssey', vin: '5FNRL5H67EB000123', mileage: 120000 },
  { id: 'car-sedan', nickname: 'Camry', year: 2009, make: 'Toyota', model: 'Camry', vin: null, mileage: 150000 },
  { id: 'car-pickup', nickname: 'F-150', year: 2005, make: 'Ford', model: 'F-150', vin: '1FTPW14505K000789', mileage: 180000 },
];
const g6Items = [
  { id: 'g-oil', name: 'Engine oil and filter' }, { id: 'g-rot', name: 'Tire rotation (every oil-life service, Maintenance I/II)' },
  { id: 'g-cool', name: 'Engine cooling system service (drain/flush/refill DEX-COOL)' }, { id: 'g-air', name: 'Engine air filter' },
];
const vanItems = [
  { id: 'v-oil', name: 'Engine oil and filter' }, { id: 'v-rot', name: 'Tire rotation' }, { id: 'v-cabin', name: 'Cabin (A/C) filter' },
  { id: 'v-atf', name: 'Automatic transmission fluid and filter' }, { id: 'v-atf-sev', name: 'Automatic transmission fluid and filter (police/taxi/fleet/frequent towing)' },
];

test('parseDate handles receipt formats and rejects junk', () => {
  assert.equal(parseDate('11/18/2026'), '2026-11-18');
  assert.equal(parseDate('11/21/26'), '2026-11-21');
  assert.equal(parseDate('2026-11-12'), '2026-11-12');
  assert.equal(parseDate('13/45/2026'), null);
  assert.equal(parseDate('soon'), null);
});

test('normalizeDraft cleans numbers, types and part numbers', () => {
  const d = normalizeDraft({ mileage: '120,418', total: '$148.32', kind: 'Parts', line_items: [{ description: 'PH4967 filter', part_number: ' PH4967 ', qty: '1', price: '11.99' }, 'Tire rotation', { description: 'x', type: 'weird', amount: 'abc' }] });
  assert.equal(d.mileage, 120418); assert.equal(d.total, 148.32); assert.equal(d.kind, 'parts');
  assert.equal(d.line_items[0].amount, 11.99); assert.equal(d.line_items[0].part_number, 'PH4967');
  assert.equal(d.line_items[1].description, 'Tire rotation'); assert.equal(d.line_items[2].type, 'part'); assert.equal(d.line_items[2].amount, null);
});

test('validation: future date is an error, low mileage and total mismatch are flagged, missing mileage is a question', () => {
  const base = { car_id: 'car-minivan', date: '2026-11-18', mileage: 120418, total: 148.32, tax: 9.86, line_items: [{ description: 'Oil', amount: 138.46, type: 'service' }] };
  let v = validateDraft(normalizeDraft(base), { cars, today: '2026-11-24' });
  assert.deepEqual(v.flags, []); assert.deepEqual(v.questions, []);
  v = validateDraft(normalizeDraft({ ...base, date: '2026-12-25' }), { cars, today: '2026-11-24' });
  assert.ok(v.flags.some(f => f.field === 'date' && f.level === 'error'));
  v = validateDraft(normalizeDraft({ ...base, mileage: 112418 }), { cars, today: '2026-11-24' });
  assert.ok(v.flags.some(f => f.field === 'mileage' && /below/.test(f.msg)));
  v = validateDraft(normalizeDraft({ ...base, total: 99 }), { cars, today: '2026-11-24' });
  assert.ok(v.flags.some(f => f.field === 'total' && /add up/.test(f.msg)));
  v = validateDraft(normalizeDraft({ ...base, mileage: null }), { cars, today: '2026-11-24' });
  assert.ok(v.questions.some(q => /Mileage missing/.test(q) && /120,000/.test(q)));
  v = validateDraft(normalizeDraft({ ...base, total: null }), { cars, today: '2026-11-24' });
  assert.equal(v.draft.total, 148.32); assert.ok(v.flags.some(f => f.field === 'total' && /added up/.test(f.msg)));
});

test('validation: car from VIN or year/make/model, unknown car asks, wrong VIN warns, same service already logged warns', () => {
  let v = validateDraft(normalizeDraft({ vehicle: { vin: '1FTPW14505K000789' }, date: '2026-11-12' }), { cars });
  assert.equal(v.car.id, 'car-pickup');
  v = validateDraft(normalizeDraft({ vehicle: { year: 2009, make: 'TOYOTA', model: 'Camry LE 2.4L' } }), { cars });
  assert.equal(v.car.id, 'car-sedan');
  v = validateDraft(normalizeDraft({ date: '2026-11-12' }), { cars });
  assert.equal(v.car, null); assert.ok(v.questions.includes('Which car is this for?'));
  v = validateDraft(normalizeDraft({ car_id: 'car-minivan', vehicle: { vin: '4T1BE46K39U000456' } }), { cars });
  assert.ok(v.flags.some(f => f.field === 'car' && /isn't/.test(f.msg)));
  v = validateDraft(normalizeDraft({ car_id: 'car-minivan', date: '2026-11-18', total: 148.32 }), { cars, services: [{ car_id: 'car-minivan', date: '2026-11-18', cost_cents: 14832, title: 'Oil change' }] });
  assert.ok(v.flags.some(f => f.field === 'duplicate'));
});

test('schedule matching: PH4967 -> oil item, coolant jug is not a flush, AI names validated, severe variant avoided, fees ignored', () => {
  const az = normalizeDraft({ kind: 'parts', line_items: [
    { description: 'Fram PH4967 oil filter', part_number: 'PH4967', amount: 11.99 },
    { description: 'Prestone universal coolant 50/50 1 gal', part_number: 'AF888', qty: 2, amount: 35.98 },
    { description: 'Environmental fee oil', type: 'fee', amount: 2 },
  ] });
  assert.deepEqual(matchItems(az, g6Items).map(m => m.id), ['g-oil']);
  // a parts purchase ignores the model's guesses (DEX-COOL jug -> "cooling system service") and keeps the rules
  const az2 = normalizeDraft({ kind: 'parts', line_items: [{ description: 'Prestone universal coolant 50/50', completes: ['Engine cooling system service (drain/flush/refill DEX-COOL)'] }, { description: 'ACDelco PF63E', completes: ['Engine oil and filter'] }] });
  assert.deepEqual(matchItems(az2, g6Items).map(m => m.id), ['g-oil']);
  const jiffy = normalizeDraft({ line_items: [
    { description: 'Signature service Pennzoil HM 5W30', completes: ['Engine oil and filter'] },
    { description: 'Tire rotation', completes: ['Tire rotation', 'Made up item'] },
    { description: 'Transmission fluid exchange' },
  ] });
  assert.deepEqual(matchItems(jiffy, vanItems).map(m => m.id), ['v-oil', 'v-rot', 'v-atf']);
  // an exact choice from the person wins over the automatic match
  assert.deepEqual(chosenItems({ ...jiffy, item_ids: ['v-cabin', 'nope'] }, vanItems).map(m => m.id), ['v-cabin']);
  assert.deepEqual(chosenItems({ ...jiffy, item_names: ['tire rotation'] }, vanItems).map(m => m.id), ['v-rot']);
});

test('to-do candidates: related open to-dos only', () => {
  const todos = [
    { id: 't1', title: 'Fix HVAC door actuator motors (blend/mode doors not moving)', status: 'open' },
    { id: 't2', title: 'Oil change needed now', status: 'open' },
    { id: 't3', title: 'Tick in the upper end of the engine', status: 'open' },
    { id: 't4', title: 'HVAC blend door', status: 'closed' },
  ];
  const ra = normalizeDraft({ title: 'HVAC actuators (parts)', line_items: [{ description: 'HVAC Blend Door Actuator' }, { description: 'HVAC Mode Door Actuator' }] });
  assert.deepEqual(todoCandidates(todos, ra).map(t => t.id), ['t1']);
  const oil = normalizeDraft({ title: 'Oil change + tire rotation', line_items: [{ description: 'Oil change' }] });
  assert.deepEqual(todoCandidates(todos, oil, [{ name: 'Engine oil and filter' }]).map(t => t.id), ['t2']);
});

test('email kind: Topdon report stays a scan; RockAuto / shop invoice / photo are receipts', () => {
  assert.equal(emailKind({ subject: 'TopScan report', attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf' }] }), 'scan');
  assert.equal(emailKind({ subject: 'Fwd: scan', text: 'Codes P0300 P0171' }), 'scan');
  assert.equal(emailKind({ subject: '', text: 'see attached', attachments: [{ filename: 'Health_Report.pdf', mimeType: 'application/pdf' }], extraText: 'TOPDON Diagnostic Report  DTC P0128 freeze frame' }), 'scan');
  assert.equal(emailKind({ subject: 'Fwd: RockAuto Order Confirmation 312884517', html: '<p>Order Total: $86.15</p>' }), 'receipt');
  assert.equal(emailKind({ subject: 'fyi', text: 'Valley Auto invoice', extraText: 'REPAIR INVOICE Labor 713.95 Parts 159.88 TOTAL $909.42' }), 'receipt');
  assert.equal(emailKind({ subject: '', text: '', attachments: [{ filename: 'IMG_1234.jpg', mimeType: 'image/jpeg' }] }), 'receipt');
  assert.equal(emailKind({ subject: 'van', text: 'Jiffy Lube subtotal 138.46 sales tax 9.86 total 148.32' }), 'receipt');
  assert.equal(emailKind({ subject: '', text: '' }), 'scan');   // nothing to go on: old behaviour
});

test('dedupe hashes: same files in any order match; text ignores case/whitespace', async () => {
  const a = { data: new TextEncoder().encode('page one').buffer }, b = { data: new TextEncoder().encode('page two').buffer };
  assert.equal(await filesHash([a, b]), await filesHash([b, a]));
  assert.notEqual(await filesHash([a]), await filesHash([b]));
  assert.equal(await textHash('Jiffy Lube\n TOTAL 148.32'), await textHash('jiffy lube total 148.32'));
});

test('mergeDrafts: Claude\'s fields win, the model fills gaps', () => {
  const m = mergeDrafts(normalizeDraft({ date: '2026-11-21', total: 98.65, line_items: [] }), normalizeDraft({ date: '2026-11-20', mileage: 150400, shop: 'AutoZone', line_items: [{ description: 'PH4967' }] }));
  assert.equal(m.date, '2026-11-21'); assert.equal(m.total, 98.65); assert.equal(m.mileage, 150400); assert.equal(m.line_items.length, 1);
});

// ---------- fake Workers AI + D1 shim
function fakeAi(script) {
  const calls = [];
  return { calls, async run(model, body) { calls.push(model); const step = script.shift(); if (!step) throw new Error('no more'); if (step.throw) throw new Error(step.throw); if (step.hang) return new Promise(() => {}); return { choices: [{ message: { content: step.text }, finish_reason: step.finish || 'stop' }] }; },
    async toMarkdown(files) { return files.map(f => ({ format: 'markdown', data: `converted ${f.name}` })); } };
}
function makeEnv(ai) {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8')); db.exec(readFileSync(new URL('./fixtures/garage.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: r.changes } }; },
  });
  const kv = new Map();
  return {
    db, kv,
    env: { DB: { prepare: sql => stmt(sql), batch: async list => Promise.all(list.map(s => s.all())) },
      FILES: { put: async (k, v) => kv.set(k, v), get: async (k, t) => { const v = kv.get(k); if (v == null) return null; if (t === 'arrayBuffer') return v instanceof ArrayBuffer ? v : new TextEncoder().encode(v).buffer; if (t === 'text') return typeof v === 'string' ? v : new TextDecoder().decode(v); return v; }, delete: async k => kv.delete(k) },
      AI: ai },
  };
}
const quiet = fn => async (...a) => { const l = console.log, w = console.warn, e = console.error; console.log = console.warn = console.error = () => {}; try { return await fn(...a); } finally { Object.assign(console, { log: l, warn: w, error: e }); } };
const FAST = { attemptMs: 200, totalMs: 2000, maxTokens: 100 };

test('robustExtract: clean / retry on bad JSON / fallback on error / failure is logged', quiet(async () => {
  let { env, db } = makeEnv(fakeAi([{ text: '{"date":"2026-11-18"}' }]));
  let r = await robustExtract(env, [], { ref: 'r1', limits: FAST });
  assert.equal(r.outcome, 'clean'); assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_failures').get().n, 0);
  ({ env, db } = makeEnv(fakeAi([{ text: '{"date": "2026-11', finish: 'length' }, { text: '```json\n{"total": 5}\n```' }])));
  r = await robustExtract(env, [], { ref: 'r2', limits: FAST });
  assert.equal(r.outcome, 'recovered'); assert.equal(r.data.total, 5); assert.equal(env.AI.calls.length, 2); assert.equal(env.AI.calls[0], env.AI.calls[1]);
  ({ env, db } = makeEnv(fakeAi([{ hang: true }, { text: '{"total": 7}' }])));
  r = await robustExtract(env, [], { ref: 'r3', limits: FAST });
  assert.equal(r.outcome, 'recovered'); assert.notEqual(env.AI.calls[0], env.AI.calls[1]);   // timeout -> straight to the fallback
  assert.equal(db.prepare("SELECT outcome FROM ai_failures WHERE ref = 'r3'").get().outcome, 'recovered');
  ({ env, db } = makeEnv(fakeAi([{ throw: 'boom' }, { text: 'sorry' }])));
  r = await robustExtract(env, [], { ref: 'r4', limits: FAST });
  assert.equal(r.outcome, 'failed'); assert.equal(r.data, null);
  const row = db.prepare("SELECT kind, outcome, trace FROM ai_failures WHERE ref = 'r4'").get();
  assert.equal(row.kind, 'receipt'); assert.equal(row.outcome, 'failed'); assert.equal(JSON.parse(row.trace).length, 2);
}));

const AI_JIFFY = JSON.stringify({ car_id: 'car-minivan', vehicle: { vin: '5FNRL5H67EB000123' }, date: '2026-11-18', mileage: 120418, shop: 'Jiffy Lube #1000', kind: 'service', title: 'Oil change + tire rotation', tax: 9.86, total: 148.32,
  line_items: [{ description: 'Signature service Pennzoil HM 5W30 6 qt', amount: 79.99, type: 'service', completes: ['Oil & filter change'] }, { description: 'Honda oil filter', part_number: '15400-PLM-A02', amount: null }, { description: 'Tire rotation', amount: 24.99, type: 'service', completes: ['Tire rotation'] }, { description: 'Rain-X wipers', amount: 37.98 }, { description: 'Shop supplies', amount: 5.5, type: 'fee' }, { description: 'Coupon', amount: -10, type: 'discount' }],
  not_performed: ['Cabin air filter'], low_confidence: [] });

test('create -> dedupe -> confirm: service logged, items done, mileage up, files moved, only ticked to-dos closed', quiet(async () => {
  const { env, db, kv } = makeEnv(fakeAi([{ text: AI_JIFFY }]));
  db.exec("UPDATE cars SET mileage = 120000 WHERE id = 'car-minivan'");
  db.exec("INSERT INTO todos (id, car_id, title, status, created_at) VALUES ('t-oil', 'car-minivan', 'Oil change and filter overdue', 'open', 1), ('t-other', 'car-minivan', 'Oil leak at the change pan', 'open', 1)");
  const photo = new TextEncoder().encode('fake jpeg bytes').buffer;
  const member = { id: 'm-owner', name: 'Pat Owner' };
  const r1 = await createReceipt(env, { source: 'app', files: [{ name: 'IMG_1.jpg', mime: 'image/jpeg', data: photo }], member });
  assert.equal(r1.duplicate, false);
  const v = r1.receipt;
  assert.equal(v.car.id, 'car-minivan'); assert.equal(v.parse_status, 'done'); assert.equal(v.draft.mileage, 120418);
  const items = db.prepare("SELECT id, name FROM schedule_items WHERE car_id = 'car-minivan'").all();
  const oil = items.find(i => /oil/i.test(i.name)), rot = items.find(i => /rotation/i.test(i.name));
  assert.deepEqual(v.matched.map(m => m.id).sort(), [oil.id, rot.id].sort());
  assert.ok(v.todo_candidates.some(t => t.id === 't-oil'));
  assert.match(v.summary, /Minivan .* 2026-11-18 · 120,418 mi · Jiffy Lube/);
  assert.equal(v.files.length, 1);
  // same photo again -> the same pending receipt, no new row
  const r2 = await createReceipt(env, { source: 'app', files: [{ name: 'again.jpg', mime: 'image/jpeg', data: photo }], member });
  assert.equal(r2.duplicate, true); assert.equal(r2.receipt.id, v.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM receipts').get().n, 1);
  assert.equal((await listPending(env)).length, 1);
  // confirm with an edit and one to-do ticked
  const out = await confirmReceipt(env, v.id, { edits: { shop: 'Jiffy Lube Main St' }, close_todo_ids: ['t-oil'] }, member, { createService, resolveCar });
  assert.equal(out.ok, true); assert.deepEqual(out.closed_todos.map(t => t.id), ['t-oil']);
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(out.service_id);
  assert.equal(svc.cost_cents, 14832); assert.equal(svc.shop, 'Jiffy Lube Main St'); assert.equal(svc.mileage, 120418); assert.match(svc.details, /15400-PLM-A02/); assert.match(svc.parts, /15400-PLM-A02/);
  assert.equal(db.prepare('SELECT last_done_miles m FROM schedule_items WHERE id = ?').get(oil.id).m, 120418);
  assert.equal(db.prepare("SELECT mileage FROM cars WHERE id = 'car-minivan'").get().mileage, 120418);
  assert.equal(db.prepare('SELECT service_id s, car_id c FROM files WHERE receipt_id = ?').get(v.id).s, out.service_id);
  assert.equal(db.prepare("SELECT status FROM todos WHERE id = 't-oil'").get().status, 'closed');
  assert.equal(db.prepare("SELECT status FROM todos WHERE id = 't-other'").get().status, 'open');
  // a second Save does nothing
  const again = await confirmReceipt(env, v.id, {}, member, { createService, resolveCar });
  assert.equal(again.already_saved, true); assert.equal(db.prepare('SELECT COUNT(*) n FROM services WHERE cost_cents = 14832').get().n, 1);
  assert.equal((await listPending(env)).length, 0);
  assert.ok([...kv.keys()].some(k => k.startsWith(`receipts/inbox/${v.id}/`)));
}));

test('Claude fields path: no AI call, loose car name, questions for missing mileage, confirm needs the car', quiet(async () => {
  const { env, db } = makeEnv(fakeAi([]));
  const sedan = await resolveCar(env, 'Toyota');
  assert.equal(sedan.id, 'car-sedan');
  const fields = { date: '2026-11-21', shop: 'AutoZone #1000', kind: 'parts', total: 98.65, tax: 6.71, line_items: [{ description: 'Fram oil filter', part_number: 'PH4967', amount: 11.99 }, { description: 'Mobil 1 HM 5W-30 5qt', amount: 32.99 }, { description: 'Prestone universal coolant 50/50', qty: 2, unit_price: 17.99, amount: 35.98 }, { description: 'Valvoline 5W-30 1qt', amount: 8.49 }, { description: 'Drain plug gasket', amount: 2.49 }] };
  const r = await createReceipt(env, { source: 'mcp', fields, text: 'AUTOZONE ... TOTAL 98.65', carRef: sedan, member: { id: 'm-owner', name: 'Pat via Claude' } });
  assert.equal(r.receipt.parse_status, 'fields'); assert.equal(env.AI.calls.length, 0);
  assert.equal(r.receipt.car.id, 'car-sedan');
  assert.ok(r.receipt.questions.some(q => /Mileage missing/.test(q)));
  assert.ok(r.receipt.questions.some(q => /Parts purchase/.test(q)));
  assert.ok(r.receipt.matched.some(m => /oil/i.test(m.name)));
  assert.ok(!r.receipt.matched.some(m => /cool/i.test(m.name)), 'a coolant jug is not a cooling-system service');
  // structured duplicate (same text) is caught
  const r2 = await createReceipt(env, { source: 'mcp', fields, text: 'autozone ...  total 98.65', carRef: sedan, member: {} });
  assert.equal(r2.duplicate, true);
  // unknown car: confirm refuses until a car is given
  const u = await createReceipt(env, { source: 'mcp', fields: { date: '2026-11-20', total: 10, line_items: [{ description: 'Wiper blade', amount: 10 }] }, member: {} });
  assert.equal(u.receipt.car, null);
  await assert.rejects(confirmReceipt(env, u.receipt.id, {}, { name: 'B' }, { createService, resolveCar }), /Which car/);
  await assert.rejects(confirmReceipt(env, u.receipt.id, { edits: { car: 'van', date: '2027-01-01' } }, { name: 'B' }, { createService, resolveCar }), /future/);
  const ok = await confirmReceipt(env, u.receipt.id, { edits: { car: 'the van', date: '2026-11-20', schedule_items: [] } }, { name: 'B' }, { createService, resolveCar });
  assert.equal(ok.car, 'Minivan'); assert.deepEqual(ok.marked_done, []);
  // discard
  const d = await discardReceipt(env, r.receipt.id);
  assert.equal(d.ok, true);
  assert.equal(db.prepare('SELECT status FROM receipts WHERE id = ?').get(r.receipt.id).status, 'discarded');
  await assert.rejects(discardReceipt(env, u.receipt.id), /Already saved/);
}));

test('email receipts are announced once (notice queue)', quiet(async () => {
  const { env } = makeEnv(fakeAi([{ text: JSON.stringify({ car_id: 'car-pickup', date: '2026-11-20', shop: 'RockAuto', kind: 'parts', total: 86.15, line_items: [{ description: 'HVAC Blend Door Actuator', brand: 'Dorman', part_number: '604101', amount: 24.79 }] }) }]));
  const r = await createReceipt(env, { source: 'email', text: 'RockAuto order 312884517 ...', html: '<p>RockAuto</p>', from: 'owner@example.com', member: { name: 'Pat by email' }, notify: true });
  const n = await unnotified(env);
  assert.equal(n.length, 1); assert.match(n[0].url, new RegExp(`#/receipt/${r.receipt.id}$`)); assert.match(n[0].title, /RockAuto \(Pickup\)/);
  assert.ok(await markNotified(env, r.receipt.id));
  assert.equal((await unnotified(env)).length, 0);
  assert.ok((await receiptView(env, r.receipt.id)).files.some(f => f.filename === 'email.html'));
  assert.match(draftSummary(r.receipt), /F-150/);
}));
