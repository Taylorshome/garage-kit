// Robust mechanic answers: truncation/empty detection, continue/retry/fallback, timeouts, what gets saved, failure log.
// Workers AI is faked with SSE streams; D1 is node:sqlite with the real migrations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { robustAnswer, classify, joinContinuation, CONTINUE_PROMPT } from '../src/answer.js';
import { FALLBACK_MODEL, MODEL } from '../src/ai.js';
import { chatRoutes } from '../src/mechanic.js';
import { aiFirstChecks, expireStaleAi } from '../src/ops.js';

const LONG = 'Check the coolant level with the engine cold, then look for drips under the water pump and the heater hoses. ';
const FAST = { startMs: 200, idleMs: 200, attemptMs: 2000, totalMs: 8000 };

/** SSE stream like Workers AI: reasoning ticks, content chunks, finish_reason on the last content chunk. */
function sse({ text = '', finish = 'stop', reasoning = 2, hangAfter = false }) {
  const enc = new TextEncoder();
  const ev = o => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
  const parts = text ? text.match(/[\s\S]{1,40}/g) : [];
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < reasoning; i++) c.enqueue(ev({ choices: [{ delta: { reasoning_content: 'hmm' } }] }));
      parts.forEach((p, i) => c.enqueue(ev({ choices: [{ delta: { content: p }, finish_reason: !hangAfter && i === parts.length - 1 ? finish : null }] })));
      if (!parts.length && !hangAfter) c.enqueue(ev({ choices: [{ delta: {}, finish_reason: finish }] }));
      if (hangAfter) return;               // never closes: idle timeout must fire
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

/** Fake env.AI: each call takes the next scripted step: {text, finish} | {throws} | {hang: true} | {hangAfter}. */
function fakeAI(steps) {
  const calls = [];
  return {
    calls,
    run: async (model, body) => {
      const step = steps[calls.length] ?? { text: LONG + 'done.' };
      calls.push({ model, body });
      if (step.throws) throw new Error(step.throws);
      if (step.hang) return new Promise(() => {});
      return sse(step);
    },
  };
}

const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Where is my coolant going?' }];

test('classify + joinContinuation', () => {
  assert.equal(classify('', { finish: 'length' }), 'empty');
  assert.equal(classify('Sure.', {}), 'empty');
  assert.equal(classify(LONG, { finish: 'length' }), 'truncated');
  assert.equal(classify(LONG, { timedOut: true }), 'truncated');
  assert.equal(classify(LONG, { finish: 'stop' }), 'ok');
  assert.equal(joinContinuation('Check the water pump weep', ' hole for drips.'), 'Check the water pump weep hole for drips.');
  assert.equal(joinContinuation('Step 3: check the radiator cap seal', 'check the radiator cap seal and the overflow hose.'), 'Step 3: check the radiator cap seal and the overflow hose.');
  assert.equal(joinContinuation('1. Look under', 'the car'), '1. Look under the car');
});

test('clean answer: one call, outcome clean', async () => {
  const AI = fakeAI([{ text: LONG }]);
  const out = [];
  const r = await robustAnswer({ AI }, msgs, { hooks: { onText: d => out.push(d) }, limits: FAST });
  assert.equal(r.status, 'ok'); assert.equal(r.outcome, 'clean'); assert.equal(r.text, LONG); assert.equal(out.join(''), LONG);
  assert.equal(AI.calls.length, 1); assert.equal(AI.calls[0].model, MODEL);
});

test('cut off (finish length): continued once on the primary, text joined, streamed once', async () => {
  const AI = fakeAI([{ text: LONG + 'Then pressure', finish: 'length' }, { text: 'test the system at 16 psi and watch for drops.' }]);
  const out = [], status = [];
  const r = await robustAnswer({ AI }, msgs, { hooks: { onText: d => out.push(d), onStatus: m => status.push(m) }, limits: FAST });
  assert.equal(r.status, 'ok'); assert.equal(r.outcome, 'recovered');
  assert.equal(r.text, LONG + 'Then pressure test the system at 16 psi and watch for drops.');
  assert.equal(out.join(''), r.text, 'client sees exactly the saved text');
  assert.equal(AI.calls[1].model, MODEL);
  const last = AI.calls[1].body.messages.slice(-2);
  assert.deepEqual(last, [{ role: 'assistant', content: LONG + 'Then pressure' }, { role: 'user', content: CONTINUE_PROMPT }]);
  assert.match(status[0], /cut off/);
});

test('empty (all reasoning, finish length): retried fresh once', async () => {
  const AI = fakeAI([{ text: '', finish: 'length' }, { text: LONG }]);
  const r = await robustAnswer({ AI }, msgs, { limits: FAST });
  assert.equal(r.status, 'ok'); assert.equal(r.outcome, 'recovered'); assert.equal(r.text, LONG);
  assert.deepEqual(r.trace.map(t => [t.mode, t.result]), [['fresh', 'empty'], ['fresh', 'ok']]);
  assert.deepEqual(AI.calls[1].body.messages, msgs);
});

test('near-empty then empty again: fallback model answers fresh, client told to reset', async () => {
  const AI = fakeAI([{ text: 'Sure,', finish: 'length' }, { text: '', finish: 'length' }, { text: LONG }]);
  let resets = 0;
  const r = await robustAnswer({ AI }, msgs, { hooks: { onReset: () => resets++ }, limits: FAST });
  assert.equal(r.status, 'ok'); assert.equal(r.model, FALLBACK_MODEL); assert.equal(r.text, LONG);
  assert.equal(AI.calls[2].model, FALLBACK_MODEL);
  assert.ok(resets >= 1);
});

test('still cut off after the continue: fallback continues the partial', async () => {
  const AI = fakeAI([{ text: LONG + 'Also', finish: 'length' }, { text: 'check B', finish: 'length' }, { text: ' and finally C is the end of it.' }]);
  const r = await robustAnswer({ AI }, msgs, { limits: FAST });
  assert.equal(r.status, 'ok'); assert.equal(r.model, FALLBACK_MODEL);
  assert.equal(r.text, LONG + 'Also check B and finally C is the end of it.');
  assert.equal(AI.calls[2].body.messages.at(-2).role, 'assistant');
});

test('cut off every time: status truncated, partial kept (never empty)', async () => {
  const AI = fakeAI([{ text: LONG, finish: 'length' }, { text: 'more words here', finish: 'length' }, { text: 'and more', finish: 'length' }]);
  const r = await robustAnswer({ AI }, msgs, { limits: FAST });
  assert.equal(r.status, 'truncated'); assert.equal(r.outcome, 'truncated');
  assert.ok(r.text.startsWith(LONG) && r.text.includes('more words here') && r.text.endsWith('and more'));
  assert.equal(AI.calls.length, 3);
});

test('nothing usable anywhere: failed with empty text', async () => {
  const AI = fakeAI([{ text: '', finish: 'length' }, { text: '', finish: 'length' }, { throws: 'fallback down' }]);
  const r = await robustAnswer({ AI }, msgs, { limits: FAST });
  assert.equal(r.status, 'failed'); assert.equal(r.text, ''); assert.match(r.error, /fallback down/);
});

test('primary error: straight to the fallback model', async () => {
  const AI = fakeAI([{ throws: '3040: capacity' }, { text: LONG }]);
  const r = await robustAnswer({ AI }, msgs, { limits: FAST });
  assert.equal(r.status, 'ok'); assert.equal(r.model, FALLBACK_MODEL); assert.equal(AI.calls.length, 2);
});

test('timeouts: a model that never starts, and a stream that stalls mid-answer', async () => {
  let AI = fakeAI([{ hang: true }, { text: LONG }]);
  let r = await robustAnswer({ AI }, msgs, { limits: FAST });
  assert.equal(r.status, 'ok'); assert.equal(r.model, FALLBACK_MODEL); assert.equal(r.trace[0].timed_out, true);
  AI = fakeAI([{ text: LONG + 'Next, check', hangAfter: true }, { text: 'the heater core for a sweet smell inside.' }]);
  r = await robustAnswer({ AI }, msgs, { limits: FAST });
  assert.equal(r.status, 'ok'); assert.equal(r.trace[0].result, 'truncated'); assert.equal(r.trace[0].timed_out, true);
  assert.ok(r.text.endsWith('Next, check the heater core for a sweet smell inside.'));
});

test('continue from a saved partial ("tap to continue")', async () => {
  const AI = fakeAI([{ text: 'the radiator cap and overflow tank for crust.' }]);
  const r = await robustAnswer({ AI }, msgs, { partial: LONG + 'Then check', limits: FAST });
  assert.equal(r.status, 'ok'); assert.equal(r.outcome, 'recovered');
  assert.equal(r.text, LONG + 'Then check the radiator cap and overflow tank for crust.');
  assert.equal(AI.calls[0].body.messages.at(-2).content, LONG + 'Then check');
});

// ---------- chat + first checks against the real schema ----------
function d1(db) {
  const prep = sql => {
    const st = db.prepare(sql);
    const bound = args => ({
      first: async () => st.get(...args) ?? null,
      all: async () => ({ results: st.all(...args) }),
      run: async () => { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; },
    });
    return { bind: (...args) => bound(args), ...bound([]) };
  };
  return { prepare: prep, batch: async stmts => Promise.all(stmts.map(s => s.all())) };
}
function freshEnv(steps) {
  const db = new DatabaseSync(':memory:');
  const MIG = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8')); db.exec(readFileSync(new URL('./fixtures/garage.sql', import.meta.url), 'utf8'));
  const AI = fakeAI(steps);
  return { db, AI, env: { DB: d1(db), AI } };
}
const route = (method, path) => { for (const [m, rx, fn] of chatRoutes) { const mm = method === m && path.match(rx); if (mm) return (args) => fn({ ...args, m: mm }); } throw new Error('no route ' + path); };
async function call(env, method, path, body = {}) {
  const waits = [];
  const res = await route(method, path)({ env, ctx: { waitUntil: p => waits.push(p) }, body, member: { name: 'Pat' } });
  if (!(res instanceof Response)) return res;
  const text = await res.text();
  await Promise.all(waits);
  return text.trim().split('\n').map(l => JSON.parse(l));
}

test('chat: failed answer is not saved; "Try again" answers the question', async () => {
  const { db, env } = freshEnv([{ text: '', finish: 'length' }, { text: '', finish: 'length' }, { throws: 'down' }, { text: LONG }]);
  // the fake streams are instant; use the real limits (they only matter when something hangs)
  const { id } = await call(env, 'POST', '/api/cars/car-minivan/chats');
  const evs = await call(env, 'POST', `/api/chats/${id}/messages`, { content: "Where's my coolant going?" });
  assert.equal(evs.at(-1).status, 'failed'); assert.ok(evs.some(e => e.t === 'error'));
  let rows = db.prepare('SELECT role, content, truncated FROM chat_messages WHERE chat_id = ? ORDER BY id').all(id);
  assert.deepEqual(rows.map(r => r.role), ['user'], 'no assistant row for a failed answer');
  const log = db.prepare('SELECT * FROM ai_failures').all();
  assert.equal(log.length, 1); assert.equal(log[0].outcome, 'failed'); assert.equal(log[0].kind, 'chat');
  const evs2 = await call(env, 'POST', `/api/chats/${id}/continue`);
  assert.equal(evs2.at(-1).status, 'ok');
  rows = db.prepare('SELECT role, content, truncated FROM chat_messages WHERE chat_id = ? ORDER BY id').all(id);
  assert.deepEqual(rows.map(r => [r.role, r.truncated]), [['user', 0], ['assistant', 0]]);
  assert.equal(rows[1].content, LONG);
});

test('chat: still cut off -> saved flagged truncated; continue completes it in place and clears the flag', async () => {
  const { db, env } = freshEnv([{ text: LONG, finish: 'length' }, { text: 'Second part', finish: 'length' }, { text: ' and third part', finish: 'length' }, { text: ' and the end of the answer.' }]);
  const { id } = await call(env, 'POST', '/api/cars/car-minivan/chats');
  const evs = await call(env, 'POST', `/api/chats/${id}/messages`, { content: 'Why does it tick?' });
  assert.equal(evs.at(-1).status, 'truncated');
  let a = db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? AND role = 'assistant'").all(id);
  assert.equal(a.length, 1); assert.equal(a[0].truncated, 1);
  assert.equal(evs.filter(e => e.t === 'c').map(e => e.d).join(''), a[0].content, 'streamed text == saved text');
  assert.equal(db.prepare('SELECT outcome FROM ai_failures').get().outcome, 'truncated');
  const evs2 = await call(env, 'POST', `/api/chats/${id}/continue`);
  assert.equal(evs2.at(-1).status, 'ok');
  a = db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? AND role = 'assistant'").all(id);
  assert.equal(a.length, 1, 'continued in place, no second row'); assert.equal(a[0].truncated, 0);
  assert.ok(a[0].content.endsWith('and the end of the answer.'));
  await assert.rejects(() => call(env, 'POST', `/api/chats/${id}/continue`), /already complete/);
});

test('first checks: ok -> done; cut off -> truncated, continue -> done; failure keeps the earlier note', async () => {
  const { db, env } = freshEnv([
    { text: LONG }, // 1st symptom: clean
    { text: LONG + 'Then', finish: 'length' }, { text: 'x', finish: 'length' }, { text: '', finish: 'length' }, // 2nd: stays cut off
    { text: 'check the cap.' }, // continue
    { throws: 'a' }, { throws: 'b' }, // ask again: fails
  ]);
  db.exec("INSERT INTO todos (id, car_id, title, notes, priority, status, created_at, type, ai_status) VALUES ('t1','car-minivan','Coolant loss','Coolant drops','high','open',0,'symptom','pending'), ('t2','car-minivan','Tick','Ticks','medium','open',0,'symptom','pending')");
  await aiFirstChecks(env, 't1');
  let t = db.prepare("SELECT * FROM todos WHERE id = 't1'").get();
  assert.equal(t.ai_status, 'done'); assert.equal(t.ai_note, LONG);
  await aiFirstChecks(env, 't2');
  t = db.prepare("SELECT * FROM todos WHERE id = 't2'").get();
  assert.equal(t.ai_status, 'truncated'); assert.ok(t.ai_note.startsWith(LONG));
  await aiFirstChecks(env, 't2', { continue: true });
  t = db.prepare("SELECT * FROM todos WHERE id = 't2'").get();
  assert.equal(t.ai_status, 'done'); assert.ok(t.ai_note.startsWith(LONG + 'Then x') && t.ai_note.endsWith('check the cap.'), t.ai_note);
  await assert.rejects(() => aiFirstChecks(env, 't1'));
  t = db.prepare("SELECT * FROM todos WHERE id = 't1'").get();
  assert.equal(t.ai_status, 'error'); assert.equal(t.ai_note, LONG, 'earlier good note kept'); assert.match(t.ai_error, /couldn't answer/);
  const outcomes = db.prepare('SELECT kind, outcome FROM ai_failures ORDER BY id').all().map(r => `${r.kind}:${r.outcome}`);
  assert.deepEqual(outcomes, ['first_checks:truncated', 'first_checks:recovered', 'first_checks:failed']);
});

test('first checks stuck in pending (background job cut off) become an error the UI can retry', async () => {
  const { db, env } = freshEnv([]);
  const old = Math.floor(Date.now() / 1000) - 600;
  db.exec(`INSERT INTO todos (id, car_id, title, priority, status, created_at, type, ai_status, ai_updated_at) VALUES ('s1','car-sedan','x','medium','open',${old},'symptom','pending',${old}), ('s2','car-sedan','y','medium','open',${old},'symptom','pending',${old + 590})`);
  assert.equal(await expireStaleAi(env, { carId: 'car-sedan' }), 1);
  assert.equal(db.prepare("SELECT ai_status FROM todos WHERE id = 's1'").get().ai_status, 'error');
  assert.equal(db.prepare("SELECT ai_status FROM todos WHERE id = 's2'").get().ai_status, 'pending');
  assert.equal(db.prepare('SELECT outcome FROM ai_failures').get().outcome, 'failed');
});
