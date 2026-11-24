import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_JUMP, milesPerMonth, parseMileageReply } from '../src/mileage.js';

test('mileage reply: numbers with commas/spaces/"mi" are accepted', () => {
  assert.deepEqual(parseMileageReply('120450', 120000), { ok: true, miles: 120450, unchanged: false });
  assert.equal(parseMileageReply(' 120,450 ', 120000).miles, 120450);
  assert.equal(parseMileageReply('120 450 mi', 120000).miles, 120450);
  assert.equal(parseMileageReply('120450miles', 120000).miles, 120450);
  assert.deepEqual(parseMileageReply('120000', 120000), { ok: true, miles: 120000, unchanged: true });
});

test('mileage reply: non-numeric is ignored', () => {
  for (const t of ['', 'abc', 'about 120k', '120.5k', '22-2000', null, undefined, '120000.5', '-5']) assert.equal(parseMileageReply(t, 120000).ok, false, String(t));
  assert.equal(parseMileageReply('abc', 120000).reason, 'not a number');
});

test('mileage reply: never lower, never more than 5,000 above', () => {
  assert.equal(parseMileageReply('119999', 120000).ok, false);
  assert.match(parseMileageReply('119999', 120000).reason, /lower/);
  assert.equal(parseMileageReply(String(120000 + MAX_JUMP), 120000).ok, true);
  assert.equal(parseMileageReply(String(120000 + MAX_JUMP + 1), 120000).ok, false);
  assert.match(parseMileageReply('128000', 120000).reason, /more than 5,000/);
  assert.equal(parseMileageReply('150', null).ok, true);   // no current reading: anything sane
  assert.equal(parseMileageReply('3000000', null).ok, false);
});

test('miles per month needs >= 60 days and an increase', () => {
  assert.equal(milesPerMonth([]), null);
  assert.equal(milesPerMonth([{ date: '2026-11-23', miles: 120000 }]), null);
  assert.equal(milesPerMonth([{ date: '2026-11-01', miles: 119000 }, { date: '2026-11-23', miles: 120000 }]), null);   // 22 days
  assert.equal(milesPerMonth([{ date: '2026-05-23', miles: 114000 }, { date: '2026-11-23', miles: 114000 }]), null);   // no increase
  assert.equal(milesPerMonth([{ date: '2026-05-24', miles: 114000 }, { date: '2026-11-23', miles: 120000 }, { date: '2026-08-01', miles: 117000 }]), 998); // 6000 mi over 183 days
  assert.equal(milesPerMonth([{ date: 'bad', miles: 1 }, { date: '2025-11-23', miles: null }, { date: '2026-11-23', miles: 150000 }]), null);
});
