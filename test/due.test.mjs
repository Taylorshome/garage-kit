import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, itemStatus, carSummary } from '../src/due.js';

test('addMonths clamps month ends', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-23', 6), '2027-05-23');
});
test('unknown last-done is unknown, not overdue', () => {
  const s = itemStatus({ interval_miles: 5000, interval_months: 6 }, 120000, '2026-11-23');
  assert.equal(s.status, 'unknown');
  assert.match(s.label, /set last done/i);
});
test('due_now is overdue / Due now', () => {
  const s = itemStatus({ interval_miles: 5000, due_now: 1 }, 180000, '2026-11-23');
  assert.equal(s.status, 'overdue'); assert.equal(s.label, 'Due now');
});
test('miles and dates drive status', () => {
  assert.equal(itemStatus({ interval_miles: 5000, last_done_miles: 200000 }, 206000, '2026-11-23').status, 'overdue');
  assert.equal(itemStatus({ interval_miles: 5000, last_done_miles: 200000 }, 204700, '2026-11-23').status, 'soon');
  assert.equal(itemStatus({ interval_miles: 5000, last_done_miles: 200000 }, 201000, '2026-11-23').status, 'ok');
  assert.equal(itemStatus({ interval_months: 6, last_done_date: '2026-05-01' }, null, '2026-11-23').status, 'overdue');
  assert.equal(itemStatus({ interval_months: 12, last_done_date: '2025-12-10' }, null, '2026-11-23').status, 'soon');
  assert.equal(itemStatus({ interval_miles: 150000, interval_months: 60, last_done_date: '2026-11-23', last_done_miles: 180000 }, 180000, '2026-11-23').status, 'ok');
});
test('health drops with overdue items and issues', () => {
  const s = carSummary({ mileage: 180000 }, [{ id: 'a', name: 'Oil', interval_miles: 5000, due_now: 1 }], [{ priority: 'high' }, { priority: 'medium' }], '2026-11-23');
  assert.equal(s.overdue_count, 1); assert.equal(s.health, 100 - 22 - 8 - 4);
  assert.equal(s.next_due.name, 'Oil');
});
