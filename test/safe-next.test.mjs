import test from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from '../src/oidc.js';

test('accepts same-origin paths', () => {
  assert.equal(safeNext('/'), '/');
  assert.equal(safeNext('/car/x?y=1#/car/x/todo'), '/car/x?y=1#/car/x/todo');
});
test('rejects open-redirect tricks', () => {
  for (const bad of ['//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com', '/\t/evil.com', '/\n/evil.com', '/.//evil.com', 'javascript:alert(1)', '', null, 42, '/\u0000x', 'evil.com', '/' + 'a'.repeat(2100)])
    assert.equal(safeNext(bad), '/', JSON.stringify(bad));
});
