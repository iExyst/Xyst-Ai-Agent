import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWebSearchProvider } from '../gui/web-search-settings.mjs';

test('web search setting saves preserve the current keyless provider by default', () => {
  assert.equal(resolveWebSearchProvider(undefined, 'automatic'), 'automatic');
  assert.equal(resolveWebSearchProvider(undefined, 'wikipedia'), 'wikipedia');
  assert.equal(resolveWebSearchProvider(undefined, undefined), 'automatic');
  assert.equal(resolveWebSearchProvider(undefined, 'brave'), 'brave');
});

test('an explicitly changed web search provider wins over the current setting', () => {
  assert.equal(resolveWebSearchProvider('automatic', 'brave'), 'automatic');
  assert.equal(resolveWebSearchProvider('wikipedia', 'brave'), 'wikipedia');
  assert.equal(resolveWebSearchProvider('brave', 'wikipedia'), 'brave');
});
