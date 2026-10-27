import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PLAN_IMPLEMENTATION_CHARACTERS,
  MAX_PLAN_PREVIEW_CHARACTERS,
  planImplementationPrompt,
  planStepsFromText,
  planTextFromSteps,
  reviewFindingsForDisplay,
} from '../gui/review-plan.mjs';

test('review findings are validated, bounded, and limited to the supported severity schema', () => {
  const safe = reviewFindingsForDisplay([
    { severity: 'high', file: 'src/a.js', line: 12, description: 'A finding', evidence: 'Evidence' },
    { severity: 'urgent', file: 'b.js', line: 1, description: 'Invalid severity', evidence: '' },
    { severity: 'low', file: 'c.js', line: -1, description: 'Invalid line', evidence: '' },
  ]);
  assert.deepEqual(safe, [{ severity: 'high', file: 'src/a.js', line: 12, description: 'A finding', evidence: 'Evidence' }]);
  assert.equal(reviewFindingsForDisplay(null).length, 0);
});

test('saved plans require explicit implementation prompt and remain marked untrusted', () => {
  const prompt = planImplementationPrompt('1. Inspect the code\n2. Add a regression test');
  assert.match(prompt, /explicitly chose to implement/);
  assert.match(prompt, /untrusted reference material/);
  assert.match(prompt, /<saved-plan>/);
  assert.throws(() => planImplementationPrompt('   '), /empty/);
  assert.throws(() => planImplementationPrompt('x'.repeat(MAX_PLAN_IMPLEMENTATION_CHARACTERS + 1)), /exceeds/);
  assert.equal(MAX_PLAN_PREVIEW_CHARACTERS, 40_000);
});

test('saved plan steps round-trip, remain editable, and reorder deterministically', () => {
  const parsed = planStepsFromText('1. Inspect the code\n   Preserve related behavior.\n2) Add a regression test\n- Run focused checks');
  assert.deepEqual(parsed, ['Inspect the code\n   Preserve related behavior.', 'Add a regression test', 'Run focused checks']);
  assert.equal(
    planTextFromSteps([parsed[2], parsed[0], parsed[1]]),
    '1. Run focused checks\n2. Inspect the code\n      Preserve related behavior.\n3. Add a regression test',
  );
  assert.throws(() => planTextFromSteps(['valid', '  ']), /Every plan step/);
  assert.throws(() => planTextFromSteps(Array(101).fill('step')), /1 to 100/);
});
