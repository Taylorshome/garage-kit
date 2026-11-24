// Guided diagnosis on the demo car + demo plan: validation, the replay engine, matching, and a whole session on SQLite
// (start -> answer -> skip -> back-edit -> finish -> fix to-do only after a yes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { computeState, finishDiagnosis, likelihoodWeight, listSessions, matchOption, normalizePlan, rankPlans, recordResult, skipStep, startDiagnosis, validatePlan } from '../src/diagnosis.js';
import { createService } from '../src/api.js';
import { carSql } from '../scripts/add-car.mjs';

const FILE = JSON.parse(readFileSync(new URL('../demo/research/diagnosis-plans.json', import.meta.url), 'utf8'));
const PLAN = { ...FILE.plans[0], car_id: 'car-demo' };
const CAR = { id: 'car-demo', nickname: 'Demo Sedan', year: 2015, make: 'Demo', model: 'Sedan' };

test('demo plan is valid; broken plans are explained', () => {
  assert.deepEqual(validatePlan(PLAN), []);
  const bad = structuredClone(PLAN);
  bad.steps[0].options[0].effects = { nope: 'up' }; bad.steps[1].sources = []; bad.steps[2].options = [bad.steps[2].options[0]];
  const e = validatePlan(bad);
  assert.ok(e.some(x => /unknown cause "nope"/.test(x))); assert.ok(e.some(x => /no sources/.test(x))); assert.ok(e.some(x => /at least 2 result options/.test(x)));
  assert.deepEqual(validatePlan(bad, { ai: true }).filter(x => /no sources/.test(x)), [], 'AI plans may lack sources');
  assert.equal(likelihoodWeight('high'), 4); assert.equal(likelihoodWeight('whatever'), 2);
});

test('engine: answers re-rank causes, a found answer ends it, skip and back-edit are replayed', () => {
  let s = computeState(PLAN, {});
  assert.equal(s.current, 'when');
  s = computeState(PLAN, { when: { result: 'all_day' } });
  assert.equal(s.current, 'pad_look');
  s = computeState(PLAN, { when: { result: 'all_day' }, pad_look: { result: 'thin' } });
  assert.equal(s.found.cause, 'pads_worn'); assert.equal(s.current, null);
  s = computeState(PLAN, { when: { result: 'all_day' }, pad_look: { result: 'skipped' } });
  assert.equal(s.current, 'slides'); assert.deepEqual(s.skipped, ['pad_look']);
  assert.equal(matchOption(normalizePlan(PLAN).steps[1], '2').key, 'thin');
  assert.equal(matchOption(normalizePlan(PLAN).steps[1], 'plenty left').key, 'thick');
  assert.equal(matchOption(normalizePlan(PLAN).steps[1], 'not sure').key, 'unsure');
});

test('matching: symptom words find the plan; unrelated symptoms and other cars do not', () => {
  const best = sym => rankPlans([{ id: PLAN.id, car_id: 'car-demo', data: PLAN, plan: normalizePlan(PLAN), source: 'research' }], CAR, sym)[0]?.plan?.id ?? null;
  const ranked = sym => rankPlans([normalizePlan(PLAN)], CAR, sym);
  const top = sym => { const r = ranked(sym); return r.length && r[0].score >= 0.6 ? r[0].plan.id : null; };
  assert.equal(top('my brakes squeal'), PLAN.id);
  assert.equal(top('squeaky brakes in the morning'), PLAN.id);
  assert.equal(top('power windows stopped'), null);
  void best;
});

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  const MIG = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  db.exec(carSql(JSON.parse(readFileSync(new URL('../demo/demo-car.json', import.meta.url), 'utf8')), { id: 'car-demo' }).sql.join('\n'));
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO diag_plans (id, car_id, version, source, symptom, title, data, status, created_at, updated_at) VALUES (?, 'car-demo', 1, 'research', ?, ?, ?, 'active', ?, ?)").run(PLAN.id, PLAN.symptom, PLAN.title, JSON.stringify(PLAN), now, now);
  const stmt = sql => { const st = db.prepare(sql); const b = a => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { const r = st.run(...a); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } }); return { bind: (...a) => b(a), ...b([]) }; };
  return { db, env: { DB: { prepare: stmt, batch: async l => Promise.all(l.map(s => s.run())) }, AI: { run: async () => { throw new Error('no AI in this test'); } } } };
}
const ME = { id: 'm-household', name: 'Pat via Claude' };
const quiet = fn => async (...a) => { const l = console.log, w = console.warn, e = console.error; console.log = console.warn = console.error = () => {}; try { return await fn(...a); } finally { Object.assign(console, { log: l, warn: w, error: e }); } };

test('session: start -> answer -> resume -> skip -> back-edit -> finish -> fix to-do only after yes', quiet(async () => {
  const { db, env } = makeEnv();
  const car = db.prepare("SELECT * FROM cars WHERE id = 'car-demo'").get();
  let v = await startDiagnosis(env, car, { symptom: 'walk me through the brake squeal' }, ME);
  assert.equal(v.plan.id, PLAN.id); assert.equal(v.step.id, 'when'); assert.equal(v.step.number, 1);
  assert.match(v._text, /SAFETY/); assert.ok(v.step.options.some(o => o.key === 'unsure'));
  const sid = v.session_id;
  const todo = db.prepare("SELECT id FROM todos WHERE car_id = 'car-demo' AND title LIKE 'Squeal%'").get();
  assert.equal(db.prepare('SELECT todo_id FROM diag_sessions WHERE id = ?').get(sid).todo_id, todo.id, 'linked to the matching symptom to-do');
  v = await recordResult(env, sid, { result: 'squeals all day', mileage: 98500 }, ME);
  assert.equal(v.step.id, 'pad_look');
  v = await startDiagnosis(env, car, { symptom: 'squeal' }, ME);
  assert.equal(v.session_id, sid); assert.equal(v.resumed, true);
  v = await skipStep(env, sid, { reason: 'raining' }, ME);
  assert.equal(v.step.id, 'slides');
  v = await recordResult(env, sid, { result: 'dry' }, ME);
  assert.equal(v.outcome, 'found'); assert.equal(v.found.cause_id, 'slides');
  v = await recordResult(env, sid, { step: 'slides', result: 'fine' }, ME);
  assert.equal(v.last_result.changed_earlier_answer, true); assert.equal(v.outcome, 'skipped_left', 'only the skipped step is left');
  await assert.rejects(recordResult(env, sid, { result: 'purple' }, ME), e => e.status === 400);
  v = await recordResult(env, sid, { step: 'pad_look', result: 'thin' }, ME);
  assert.equal(v.found.cause_id, 'pads_worn');
  v = await finishDiagnosis(env, sid, {}, ME, createService);
  assert.equal(v.status, 'found'); assert.match(v.conclusion, /Pads down to the wear indicator/);
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(v.service_id);
  assert.match(svc.title, /^Diagnosis: /); assert.equal(svc.mileage, 98500);
  assert.match(db.prepare('SELECT notes FROM todos WHERE id = ?').get(todo.id).notes, /guided diagnosis/);
  assert.equal(db.prepare('SELECT status FROM todos WHERE id = ?').get(todo.id).status, 'open', 'never closes the to-do');
  assert.ok(v.fix_todo_proposal); assert.equal(db.prepare("SELECT COUNT(*) n FROM todos WHERE source LIKE 'diagnosis:%'").get().n, 0);
  await assert.rejects(recordResult(env, sid, { result: 'thick' }, ME), e => e.status === 409);
  v = await finishDiagnosis(env, sid, { create_fix_todo: true }, ME, createService);
  assert.equal(v.fix_todo_created, true);
  v = await finishDiagnosis(env, sid, { create_fix_todo: true }, ME, createService);
  assert.equal(v.fix_todo_created, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM todos WHERE source = ?").get(`diagnosis:${sid}`).n, 1);
  const list = await listSessions(env, { carId: 'car-demo' });
  assert.equal(list[0].session_id, sid); assert.equal(list[0].status, 'found');
}));

test('no matching plan: needs_plan lists what exists (AI generation only on request)', quiet(async () => {
  const { db, env } = makeEnv();
  const car = db.prepare("SELECT * FROM cars WHERE id = 'car-demo'").get();
  const v = await startDiagnosis(env, car, { symptom: 'radio turns itself off' }, ME);
  assert.equal(v.needs_plan, true); assert.ok(v.available_plans.some(p => p.plan_id === PLAN.id));
}));
