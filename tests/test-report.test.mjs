import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSkippedTests, parseSkippedTests } from '../scripts/tap-summary.mjs';

test('test report lists every TAP skip with its reason and checks the summary count', () => {
  const output = [
    'TAP version 13',
    'ok 1 - a supported test',
    'ok 2 - linux sandbox # SKIP requires Linux',
    'ok 3 - optional backend # SKIP',
    '# tests 3',
    '# pass 1',
    '# fail 0',
    '# skipped 2',
  ].join('\n');
  const skipped = parseSkippedTests(output);
  assert.deepEqual(skipped, [
    { name: 'linux sandbox', reason: 'requires Linux' },
    { name: 'optional backend', reason: 'no skip reason supplied' },
  ]);
  assert.equal(
    formatSkippedTests(skipped),
    'Skipped tests (2):\n  - linux sandbox: requires Linux\n  - optional backend: no skip reason supplied',
  );
  assert.equal(formatSkippedTests([]), 'Skipped tests: none');
  assert.throws(() => parseSkippedTests(output.replace('# skipped 2', '# skipped 3')), /but 2 skip records were parsed/);
});
