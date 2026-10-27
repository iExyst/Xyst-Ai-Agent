import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractiveCompleter } from '../src/cli/completions.mjs';

const complete = createInteractiveCompleter({ models: { local: {}, remote: {}, 'local-plus': {} } });

test('interactive completion suggests slash commands from a partial command', () => {
  assert.deepEqual(complete('/sta'), [['/status'], '/sta']);
  assert.deepEqual(complete('/'), [
    [
      '/budget',
      '/clear',
      '/compact',
      '/exit',
      '/goals',
      '/help',
      '/memory',
      '/mode',
      '/model',
      '/permissions',
      '/quit',
      '/recap',
      '/search',
      '/sessions',
      '/status',
      '/usage',
    ],
    '/',
  ]);
});

test('interactive completion suggests configured model profiles while preserving the command', () => {
  assert.deepEqual(complete('/model lo'), [['/model local', '/model local-plus'], '/model lo']);
  assert.deepEqual(complete('/model '), [['/model local', '/model remote', '/model local-plus'], '/model ']);
});

test('interactive completion suggests valid modes and leaves non-command input alone', () => {
  assert.deepEqual(complete('/mode r'), [['/mode review'], '/mode r']);
  assert.deepEqual(complete('ordinary prompt'), [[], 'ordinary prompt']);
  assert.deepEqual(complete('/unknown'), [[], '/unknown']);
});
