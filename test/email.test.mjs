import test from 'node:test';
import assert from 'node:assert/strict';
import { findCodes, findVins, matchCar, reconcile, senderCheck, stripHtml, vinCheckOk, replyText } from '../src/email.js';

const cars = [
  { id: 'minivan', year: 2014, make: 'Honda', model: 'Odyssey', vin: null },
  { id: 'sedan', year: 2009, make: 'Toyota', model: 'Camry', vin: null },
  { id: 'pickup', year: 2005, make: 'Ford', model: 'F-150', vin: '1FTPW14555K000111' },
];
test('VIN check digit', () => {
  assert.ok(vinCheckOk('1HGCM82633A004352') === vinCheckOk('1HGCM82633A004352'));
  assert.ok(vinCheckOk('11111111111111111')); // classic valid test VIN
  assert.ok(!vinCheckOk('11111111211111111'));
});
test('finds DTCs', () => assert.deepEqual(findCodes('codes: P0300, p0171 and U0100. Not PO300'), ['P0300', 'P0171', 'U0100']));
test('matches by VIN then YMM', () => {
  assert.equal(matchCar(cars, { vin: '1FTPW14555K000111' }).car.id, 'pickup');
  assert.equal(matchCar(cars, { year: 2014, make: 'HONDA', model: 'Odyssey' }).car.id, 'minivan');
  assert.equal(matchCar(cars, { year: 2009, make: 'Toyota', model: 'Camry LE' }).car.id, 'sedan');
  assert.equal(matchCar(cars, { year: 2010, make: 'Toyota', model: 'Camry' }).car, null);
  assert.equal(matchCar(cars, { make: 'FORD', model: 'F-150 XLT' }).car.id, 'pickup');
});
test('reconcile drops invented codes and keeps pattern ones', () => {
  const text = 'Engine: P0300 Random misfire. P0128 coolant thermostat';
  const x = reconcile({ codes: [{ code: 'P0300', description: 'Random/Multiple Misfire', module: 'Engine' }, { code: 'P0420', description: 'made up' }], mileage: '120,500' }, text);
  assert.deepEqual(x.codes.map(c => c.code), ['P0300', 'P0128']);
  assert.equal(x.mileage, null); // not a clean number -> null rather than a guess
});
test('stripHtml', () => assert.equal(stripHtml('<p>a&amp;b</p><script>x</script><div>c</div>'), 'a&b\nc'));
test('reply text', () => assert.match(replyText({ car: { nickname: 'Camry' }, match_how: 'VIN', codes: [{ code: 'P0300' }], new_todos: ['P0300'], notes: [] }), /Matched to: Camry/));

test('senderCheck: header From must be allowlisted; envelope-only needs SPF pass; dmarc=fail always refused', () => {
  const allowed = new Set(['pat@example.com']);
  const H = o => ({ get: n => o[n] ?? null });
  const CF_PASS = 'i=1; mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com; spf=pass smtp.mailfrom=pat@example.com';
  // the normal case: the person mails it from their own account
  assert.equal(senderCheck({ envelopeFrom: 'pat@example.com', headerFrom: 'pat@example.com', allowed, headers: H({ 'ARC-Authentication-Results': CF_PASS }) }).ok, true);
  // header From spoofed on a DMARC domain: Cloudflare records dmarc=fail
  assert.equal(senderCheck({ envelopeFrom: 'x@evil.test', headerFrom: 'pat@example.com', allowed, headers: H({ 'ARC-Authentication-Results': 'i=1; mx.cloudflare.net; dmarc=fail header.from=example.com' }) }).ok, false);
  // envelope forged (attacker's own DMARC-passing header From, allowlisted MAIL FROM): SPF softfail -> refused
  const forged = senderCheck({ envelopeFrom: 'pat@example.com', headerFrom: 'x@evil.test', allowed, headers: H({ 'ARC-Authentication-Results': 'i=1; mx.cloudflare.net; dkim=pass header.d=evil.test; dmarc=pass header.from=evil.test; spf=softfail smtp.mailfrom=pat@example.com', 'Received-SPF': 'softfail (mx.cloudflare.net: domain of transitioning pat@example.com does not designate 192.0.2.1 as permitted sender)' }) });
  assert.equal(forged.ok, false); assert.match(forged.reason, /softfail/);
  // ...and adding a fake "spf=pass" header doesn't hide the real verdict
  assert.equal(senderCheck({ envelopeFrom: 'pat@example.com', headerFrom: 'x@evil.test', allowed, headers: H({ 'Authentication-Results': 'fake; spf=pass', 'ARC-Authentication-Results': 'i=1; mx.cloudflare.net; spf=softfail' }) }).ok, false);
  // no SPF information at all -> the envelope alone isn't trusted
  assert.equal(senderCheck({ envelopeFrom: 'pat@example.com', headerFrom: 'store@shop.test', allowed, headers: H({}) }).ok, false);
  // auto-forwarded receipt: header From is the store, envelope is the allowlisted person with SPF pass
  assert.equal(senderCheck({ envelopeFrom: 'pat@example.com', headerFrom: 'store@shop.test', allowed, headers: H({ 'ARC-Authentication-Results': 'i=1; mx.cloudflare.net; dkim=pass header.d=shop.test; dmarc=pass header.from=shop.test; spf=pass smtp.mailfrom=pat@example.com', 'Received-SPF': 'pass (mx.cloudflare.net: domain of pat@example.com designates 192.0.2.9 as permitted sender)' }) }).how, 'envelope');
  // not allowlisted at all
  assert.equal(senderCheck({ envelopeFrom: 'x@evil.test', headerFrom: 'x@evil.test', allowed, headers: H({ 'ARC-Authentication-Results': CF_PASS }) }).reject, 'Sender not allowed');
});
