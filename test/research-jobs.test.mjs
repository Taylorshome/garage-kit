// Research queue reliability: stuck "running" jobs are requeued once then failed, and each failure is reported once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { STALE_SEC, announceFailures, claimNext, listQueued, markFailureNotified, queueJob, saveManualReport, submitResult, unnotifiedFailureCount, unnotifiedFailures } from '../src/research-jobs.js';

function freshEnv() {
  const db = new DatabaseSync(':memory:');
  const MIG = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8')); db.exec(readFileSync(new URL('./fixtures/garage.sql', import.meta.url), 'utf8'));
  const prep = sql => {
    const st = db.prepare(sql);
    const bound = args => ({ first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }), run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }) });
    return { bind: (...a) => bound(a), ...bound([]) };
  };
  db.exec("INSERT INTO todos (id, car_id, title, priority, status, created_at) VALUES ('t1', 'car-sedan', 'Overheats', 'high', 'open', 0)");
  return { db, env: { DB: { prepare: prep, batch: async s => Promise.all(s.map(x => x.all())) }, APP_ORIGIN: 'https://garage.test' } };
}
const now = () => Math.floor(Date.now() / 1000);

test('stuck running job: requeued once, then failed, then reported exactly once', async () => {
  const { db, env } = freshEnv();
  const old = now() - STALE_SEC - 60;
  db.exec(`INSERT INTO research_jobs (id, todo_id, car_id, status, attempts, created_at, started_at) VALUES ('j1', 't1', 'car-sedan', 'running', 1, ${old}, ${old})`);
  // the next poll sweeps it back to queued and claims it again (attempt 2)
  const job = await claimNext(env).catch(() => null);   // carContext needs research rows; claim itself is what matters
  let j = db.prepare("SELECT * FROM research_jobs WHERE id = 'j1'").get();
  assert.equal(j.status, 'running'); assert.equal(j.attempts, 2);
  assert.match(j.error, /timed out; retrying/);
  // stuck again -> failed
  db.exec(`UPDATE research_jobs SET started_at = ${old} WHERE id = 'j1'`);
  assert.equal(await unnotifiedFailureCount(env), 0);
  const f = await unnotifiedFailures(env);   // runs the sweep too
  j = db.prepare("SELECT * FROM research_jobs WHERE id = 'j1'").get();
  assert.equal(j.status, 'failed'); assert.match(j.error, /stopped responding/);
  assert.equal(f.length, 1); assert.equal(f[0].car, 'Sedan'); assert.equal(f[0].url, '#/car/car-sedan/todo');
  assert.equal(await markFailureNotified(env, 'j1'), true);
  assert.equal(await markFailureNotified(env, 'j1'), false, 'second mark is a no-op (never notify twice)');
  assert.equal((await unnotifiedFailures(env)).length, 0);
  void job;
});

test('worker-reported failure: retried once by the server, then failed and announced exactly once', async () => {
  const { db, env } = freshEnv();
  db.exec(`INSERT INTO research_jobs (id, todo_id, car_id, status, attempts, created_at, started_at) VALUES ('j2', 't1', 'car-sedan', 'running', 1, ${now()}, ${now()})`);
  assert.equal((await submitResult(env, 'j2', { ok: false, error: 'timed out after 12 min' })).status, 'queued');
  db.exec(`UPDATE research_jobs SET status = 'running', attempts = 2 WHERE id = 'j2'`);
  assert.equal((await submitResult(env, 'j2', { ok: false, error: 'claude: error' })).status, 'failed');
  // the final failure is announced right away through notify() (stored; no channel enabled in this env) and marked
  assert.equal(await unnotifiedFailureCount(env), 0);
  const n = db.prepare("SELECT kind, title, body, url FROM notifications").all();
  assert.equal(n.length, 1); assert.equal(n[0].kind, 'research_failed'); assert.match(n[0].title, /research failed \(Sedan\)/); assert.match(n[0].body, /claude: error/);
  assert.equal(await announceFailures(env), 0, 'nothing left to announce');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 1);
});

test('a successful report is stored and announced', async () => {
  const { db, env } = freshEnv();
  db.exec(`INSERT INTO research_jobs (id, todo_id, car_id, status, attempts, created_at, started_at) VALUES ('j3', 't1', 'car-sedan', 'running', 1, ${now()}, ${now()})`);
  const report = { summary: 'Most likely a stuck thermostat; check it before anything else.', likely_causes: [{ cause: 'thermostat', likelihood: 'high' }], check_order: ['look'], safe_to_drive: { verdict: 'no', why: 'overheats' }, parts: [], videos: [], sources: [{ title: 's', url: 'https://example.com/a' }], questions_for_owner: [] };
  assert.equal((await submitResult(env, 'j3', { ok: true, report })).status, 'done');
  const n = db.prepare("SELECT kind, title, body, url FROM notifications").get();
  assert.equal(n.kind, 'research'); assert.match(n.body, /Don't drive it/); assert.equal(n.url, '#/car/car-sedan/todo');
  assert.ok(db.prepare("SELECT researched_at FROM todos WHERE id = 't1'").get().researched_at);
});

test('manual report (MCP save_symptom_report / loader) completes the queued job; bad reports are refused', async () => {
  const { db, env } = freshEnv();
  await queueJob(env, 't1', 'Pat');
  assert.equal((await listQueued(env)).length, 1);
  await assert.rejects(saveManualReport(env, 't1', { summary: 'x' }, 'Pat via Claude'), /likely_causes|safe_to_drive/);
  const report = { summary: 'Most likely a stuck thermostat; check it first.', likely_causes: [{ cause: 'thermostat' }], check_order: [], safe_to_drive: { verdict: 'caution' }, parts: [], videos: [], sources: [{ url: 'https://example.com/b' }], questions_for_owner: [] };
  const r = await saveManualReport(env, 't1', report, 'Pat via Claude');
  assert.equal(r.ok, true);
  assert.equal(db.prepare("SELECT status FROM research_jobs WHERE id = ?").get(r.job_id).status, 'done');
  assert.equal((await listQueued(env)).length, 0);
});

test('migration: failures that existed before the notifier are not reported retroactively', () => {
  const db = new DatabaseSync(':memory:');
  const MIG = new URL('../migrations/', import.meta.url);
  const files = readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
  for (const f of files.filter(f => f < '0010')) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  db.exec("INSERT INTO cars (id, nickname, created_at, updated_at) VALUES ('car-sedan', 'Sedan', 0, 0)");
  db.exec("INSERT INTO todos (id, car_id, title, priority, status, created_at) VALUES ('t1', 'car-sedan', 'x', 'high', 'open', 0)");
  db.exec("INSERT INTO research_jobs (id, todo_id, car_id, status, attempts, created_at, finished_at) VALUES ('old', 't1', 'car-sedan', 'failed', 2, 1, 2)");
  for (const f of files.filter(f => f >= '0010')) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  assert.equal(db.prepare("SELECT failure_notified_at FROM research_jobs WHERE id = 'old'").get().failure_notified_at, 2);
});
