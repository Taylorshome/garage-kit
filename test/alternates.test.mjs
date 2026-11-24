import test from 'node:test';
import assert from 'node:assert/strict';
import { alternatesFor } from '../src/alternates.js';

const part = {
  part: 'Oil filter', category: 'engine', pick: 'WIX 51522 from RockAuto',
  options: [
    { brand: 'Fram', tier: 'value', part_number: 'PH46', verdict: 'avoid', reputation: 'thin media', where: 'local' },
    { brand: 'ACDelco', tier: 'oem', part_number: 'PF61E', price_usd: 8.99, verdict: 'best quality', where: 'RockAuto' },
    { brand: 'Mobil 1', tier: 'premium', part_number: 'M1-206A', verdict: 'budget OK', where: 'Walmart' },
    { brand: 'WIX', tier: 'premium', part_number: '51522', price_usd: '6.50', verdict: 'best value', where: 'RockAuto' },
    { brand: 'Bosch', tier: 'premium', part_number: '3423', verdict: 'budget OK', where: 'RockAuto', fitment: 'verify fitment' },
  ],
  avoid: [{ brand: 'No-name', why: 'leaks' }],
};

test('OEM first, then non-avoid alternates RockAuto first, avoid kept separate', () => {
  const a = alternatesFor(part);
  assert.equal(a.first_choice.part_number, 'PF61E'); assert.equal(a.first_choice.is_oem, true);
  assert.deepEqual(a.alternates.map(o => o.brand), ['WIX', 'Bosch', 'Mobil 1']);
  assert.equal(a.alternates[0].is_pick, true); assert.equal(a.alternates[0].price_usd, 6.5);
  assert.equal(a.alternates[1].verify_fitment, true);
  assert.deepEqual(a.avoid.map(x => x.brand), ['Fram', 'No-name']);
  assert.equal(a.no_alternate, false);
});

test('no OEM: the pick is first; a single option has no alternate', () => {
  const a = alternatesFor({ part: 'Cabin filter', pick: 'PTC', options: [{ brand: 'PTC', part_number: '3021A', tier: 'value', verdict: 'budget OK', where: 'RockAuto' }] });
  assert.equal(a.first_choice.brand, 'PTC'); assert.equal(a.no_alternate, true); assert.equal(a.alternates.length, 0);
});
