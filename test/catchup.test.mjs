import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWERS, estimateFor, isPending, monthsAgo, needsCatchup } from '../src/catchup.js';
import { itemStatus, carSummary } from '../src/due.js';

const today = '2026-11-24';

test('monthsAgo: whole months clamp month ends, fractions count days', () => {
  assert.equal(monthsAgo(today, 3), '2026-08-24');
  assert.equal(monthsAgo(today, 12), '2025-11-24');
  assert.equal(monthsAgo(today, 24), '2024-11-24');
  assert.equal(monthsAgo('2026-05-31', 3), '2026-02-28');
  assert.equal(monthsAgo(today, 0.5), '2026-11-09');   // 15 days
  assert.equal(monthsAgo('2026-01-10', 0.5), '2025-12-26');  // across a year boundary
});

test('dated answers: date only (miles null) when miles/month is unknown', () => {
  const e = estimateFor('6mo', { today, mileage: 120000, mpm: null });
  assert.deepEqual(e, { last_done_date: '2026-05-24', last_done_miles: null, last_done_estimated: 1, due_now: 0 });
});

test('dated answers: miles from miles/month, rounded to 100, never negative', () => {
  assert.equal(estimateFor('1yr', { today, mileage: 151000, mpm: 850 }).last_done_miles, 140800);   // 151000 - 10200
  assert.equal(estimateFor('this_month', { today, mileage: 151040, mpm: 900 }).last_done_miles, 150600); // 151040 - 450
  assert.equal(estimateFor('2yr', { today, mileage: 5000, mpm: 1000 }).last_done_miles, 0);
  assert.equal(estimateFor('3mo', { today, mileage: null, mpm: 1000 }).last_done_miles, null);
});

test("Don't remember: nothing set, reviewed; Never: due now", () => {
  assert.deepEqual(estimateFor('unknown', { today, mileage: 1 }), { last_done_date: null, last_done_miles: null, last_done_estimated: 0, due_now: null });
  assert.equal(estimateFor('never', { today }).due_now, 1);
  assert.throws(() => estimateFor('yesterday', { today }), /Unknown answer/);
  assert.equal(Object.keys(ANSWERS).length, 7);
});

test('pending / needs catch-up', () => {
  assert.equal(isPending({}), true);
  assert.equal(isPending({ catchup_answer: 'unknown' }), false);
  assert.equal(isPending({ last_done_date: '2026-01-01', last_done_estimated: 1 }), false);
  assert.equal(needsCatchup({ last_done_date: '2026-01-01', last_done_estimated: 1 }), true);
  assert.equal(needsCatchup({ last_done_date: '2026-01-01', last_done_estimated: 0 }), false);   // real history: never touched
  const s = carSummary({ mileage: 1000 }, [{ id: 'a' }, { id: 'b', catchup_answer: 'unknown' }, { id: 'c', last_done_date: '2026-01-01' }], [], today);
  assert.equal(s.catchup_pending, 1);
});

test('estimated items are tracked and labelled with ~', () => {
  const e = estimateFor('1yr', { today, mileage: 120000, mpm: null });
  const s = itemStatus({ interval_months: 6, ...e }, 120000, today);
  assert.equal(s.status, 'overdue'); assert.equal(s.estimated, true); assert.match(s.label, /~\d+ days over/);
  const ok = itemStatus({ interval_months: 24, ...estimateFor('3mo', { today }) }, 120000, today);
  assert.equal(ok.status, 'ok'); assert.match(ok.label, /next ~2028-08-24/);
  // miles-only item with a date-only estimate: still unknown, but says so
  const mo = itemStatus({ interval_miles: 30000, ...estimateFor('6mo', { today }) }, 120000, today);
  assert.equal(mo.status, 'unknown'); assert.match(mo.label, /~2026-05-24; miles unknown/);
});
