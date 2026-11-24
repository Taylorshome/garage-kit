// save_research end to end through handleMcp, on the real migrations in an in-memory node:sqlite DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handleMcp } from '../src/mcp.js';
import { planResearchWrite } from '../src/research-write.js';

const MIG = new URL('../migrations/', import.meta.url);

/** Minimal D1 shim over node:sqlite (?1-style params bind positionally, which matches ?NNN). */
function d1(db) {
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      const bound = args => ({
        first: async () => st.get(...args) ?? null,
        all: async () => ({ results: st.all(...args) }),
        run: async () => { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; },
      });
      return { bind: (...args) => bound(args), ...bound([]) };
    },
  };
}

function freshEnv() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8')); db.exec(readFileSync(new URL('./fixtures/garage.sql', import.meta.url), 'utf8'));
  return { db, env: { DB: d1(db) } };
}

let seq = 0;
async function callTool(env, memberId, args) {
  const req = new Request('https://garage.test/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: 'save_research', arguments: args } }) });
  const res = await handleMcp(req, env, { props: { member_id: memberId, client: 'test' }, waitUntil() {} });
  const body = await res.json();
  return body.result;
}

const researchOf = (db, car) => JSON.parse(db.prepare('SELECT data FROM research WHERE car_id = ?').get(car).data);
const vanRow = db => db.prepare("SELECT r.data, r.updated_at FROM research r JOIN cars c ON c.id = r.car_id WHERE c.id = 'car-minivan'").get();
const CHECKLIST = { symptom: 'Brake pedal pulses at highway speed', likely_causes: [{ cause: 'Warped front rotors', likelihood: 'high', how_to_check: 'Feel for pulsing; measure runout', fix: 'Replace rotors and pads', cost: '$120-200 DIY' }] };

test('migrations seed a van with no research row yet (sanity)', () => {
  const { db } = freshEnv();
  const cars = db.prepare('SELECT nickname FROM cars').all().map(c => c.nickname);
  assert.ok(cars.length >= 3, `cars: ${cars}`);
  assert.equal(db.prepare('SELECT is_owner FROM members WHERE id = ?').get('m-owner').is_owner, 1);
});

test('adds new entries for the owner and attributes nothing extra into the data', async () => {
  const { db, env } = freshEnv();
  db.prepare("INSERT INTO research (car_id, data, updated_at) SELECT id, ?, 100 FROM cars WHERE id = 'car-minivan'").run(JSON.stringify({ symptom_diagnosis: [{ symptom: 'Tick in upper end of engine', likely_causes: [] }], questions: ['VIN?'] }));
  const r = await callTool(env, 'm-owner', { car: 'van', section: 'symptom_checklists', entries: [CHECKLIST] });
  assert.equal(r.isError, false, r.content[0].text);
  assert.deepEqual(r.structuredContent.added, [CHECKLIST.symptom]);
  assert.equal(r.structuredContent.saved, true);
  const d = researchOf(db, 'car-minivan');
  assert.equal(d.symptom_diagnosis.length, 2);
  assert.deepEqual(d.symptom_diagnosis[1], CHECKLIST);
  assert.deepEqual(d.questions, ['VIN?'], 'other sections untouched');
  assert.ok(vanRow(db).updated_at > 100);
});

test('creates the research row when the car has none', async () => {
  const { db, env } = freshEnv();
  db.prepare("DELETE FROM research WHERE car_id = (SELECT id FROM cars WHERE id = 'car-minivan')").run();
  const r = await callTool(env, 'm-owner', { car: 'van', section: 'questions', entries: ['Which oil filter was used last?'] });
  assert.equal(r.isError, false, r.content[0].text);
  assert.deepEqual(researchOf(db, 'car-minivan').questions, ['Which oil filter was used last?']);
});

test('skips entries that already exist (case/whitespace-insensitive) unless overwrite', async () => {
  const { db, env } = freshEnv();
  db.prepare("INSERT OR REPLACE INTO research (car_id, data, updated_at) SELECT id, ?, 100 FROM cars WHERE id = 'car-minivan'").run(JSON.stringify({ tsbs: [{ number: '09-002-14 REV. B', title: 'Old title' }] }));
  const before = vanRow(db);
  const r = await callTool(env, 'm-owner', { car: 'van', section: 'tsbs', entries: [{ number: '09-002-14  rev. b', title: 'New title' }] });
  assert.equal(r.isError, false, r.content[0].text);
  assert.deepEqual(r.structuredContent.skipped, ['09-002-14  rev. b']);
  assert.deepEqual(r.structuredContent.added, []);
  assert.equal(r.structuredContent.saved, false);
  assert.deepEqual(vanRow(db), before, 'row not rewritten');
});

test('overwrite replaces the existing entry in place', async () => {
  const { db, env } = freshEnv();
  db.prepare("INSERT OR REPLACE INTO research (car_id, data, updated_at) SELECT id, ?, 100 FROM cars WHERE id = 'car-minivan'").run(JSON.stringify({ known_issues: [{ title: 'TIPM failure', fix: 'old' }, { title: 'Oil cooler leak', fix: 'keep' }] }));
  const r = await callTool(env, 'm-owner', { car: 'van', section: 'known_issues', overwrite: true, entries: [{ title: 'tipm FAILURE', fix: 'new' }, { title: 'Rear wiper motor', fix: 'replace' }] });
  assert.equal(r.isError, false, r.content[0].text);
  assert.deepEqual(r.structuredContent.replaced, ['tipm FAILURE']);
  assert.deepEqual(r.structuredContent.added, ['Rear wiper motor']);
  assert.deepEqual(researchOf(db, 'car-minivan').known_issues.map(k => k.fix), ['new', 'keep', 'replace']);
});

test('dry_run reports the plan and saves nothing', async () => {
  const { db, env } = freshEnv();
  db.prepare("INSERT OR REPLACE INTO research (car_id, data, updated_at) SELECT id, ?, 100 FROM cars WHERE id = 'car-minivan'").run(JSON.stringify({ recalls: [{ campaign: '14V234000', summary: 'switch' }] }));
  const before = vanRow(db);
  const r = await callTool(env, 'm-owner', { car: 'van', section: 'recalls', dry_run: true, overwrite: true, entries: [{ campaign: '14V234000', summary: 'updated' }, { campaign: '15V000000', summary: 'new' }] });
  assert.equal(r.isError, false, r.content[0].text);
  const s = r.structuredContent;
  assert.equal(s.dry_run, true); assert.equal(s.saved, false);
  assert.deepEqual(s.replaced, ['14V234000']); assert.deepEqual(s.added, ['15V000000']); assert.equal(s.total_after, 2);
  assert.deepEqual(vanRow(db), before, 'nothing written');
});

test('owner only: a non-owner member is refused and nothing changes', async () => {
  const { db, env } = freshEnv();
  const before = vanRow(db);
  const r = await callTool(env, 'm-member', { car: 'van', section: 'questions', entries: ['Should not land'] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /owner/i);
  assert.deepEqual(vanRow(db), before);
});

test('optimistic lock: a row changed between read and write is not clobbered', async () => {
  const { db, env } = freshEnv();
  db.prepare("INSERT OR REPLACE INTO research (car_id, data, updated_at) SELECT id, ?, 100 FROM cars WHERE id = 'car-minivan'").run(JSON.stringify({ questions: ['a'] }));
  // simulate a concurrent writer: change the row right after save_research reads it
  const racing = { DB: { prepare(sql) {
    const p = env.DB.prepare(sql);
    if (!sql.startsWith('SELECT data, updated_at FROM research')) return p;
    return { bind: (...a) => ({ first: async () => { const row = await p.bind(...a).first(); db.prepare('UPDATE research SET data = ?, updated_at = 101 WHERE car_id = ?').run(JSON.stringify({ questions: ['a', 'other writer'] }), a[0]); return row; } }) };
  } } };
  const r = await callTool(racing, 'm-owner', { car: 'van', section: 'questions', entries: ['b'] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /changed while saving/);
  assert.deepEqual(researchOf(db, 'car-minivan').questions, ['a', 'other writer']);
});

test('rejects bad input', async () => {
  const { env } = freshEnv();
  for (const args of [
    { car: 'van', section: 'specs', entries: [{}] },
    { car: 'van', section: 'tsbs', entries: [] },
    { car: 'van', section: 'tsbs', entries: [{ summary: 'no number or title' }] },
    { car: 'van', section: 'questions', entries: ['x', 'X '] },
    { car: 'van', section: 'questions', entries: ['x'], dry_run: 'yes' },
  ]) {
    const r = await callTool(env, 'm-owner', args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
});

test('planResearchWrite leaves legacy entries without a key alone', () => {
  const p = planResearchWrite({ known_issues: [{ note: 'no title' }] }, 'known_issues', [{ title: 'New' }], false);
  assert.deepEqual(p.next.known_issues, [{ note: 'no title' }, { title: 'New' }]);
});
