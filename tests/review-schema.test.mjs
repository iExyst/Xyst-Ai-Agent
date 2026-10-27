import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewFindings } from '../src/architect/review-schema.mjs';

test('review report parser normalizes workspace paths and keeps only bounded finding fields', () => {
  const parsed = parseReviewFindings(
    JSON.stringify([
      {
        severity: 'high',
        file: '.\\src\\agent.mjs',
        line: 12,
        description: '  Check this result.  ',
        evidence: '  Value reaches this branch.  ',
        untrusted_extra_field: 'discarded',
      },
    ]),
  );
  assert.deepEqual(parsed, [
    {
      severity: 'high',
      file: 'src/agent.mjs',
      line: 12,
      description: 'Check this result.',
      evidence: 'Value reaches this branch.',
    },
  ]);
});

test('review report parser accepts the structured-output object and still rejects extra top-level fields', () => {
  const finding = {
    severity: 'medium',
    file: 'src/file.mjs',
    line: null,
    description: 'Check the result.',
    evidence: 'The branch omits validation.',
  };
  assert.deepEqual(parseReviewFindings(JSON.stringify({ findings: [finding] })), [finding]);
  assert.equal(parseReviewFindings(JSON.stringify({ findings: [], summary: 'clean' })), null);
  assert.equal(parseReviewFindings(JSON.stringify({ other: [] })), null);
});

test('review report parser rejects the entire report for invalid fields or workspace escapes', () => {
  const valid = { severity: 'low', file: 'src/file.mjs', line: null, description: 'Finding', evidence: 'Evidence' };
  for (const change of [
    { severity: 'urgent' },
    { file: '../outside.txt' },
    { file: 'C:\\outside.txt' },
    { file: '/outside.txt' },
    { line: 0 },
    { line: 1.5 },
    { description: '' },
    { evidence: '' },
    { evidence: 'x'.repeat(8_001) },
  ]) {
    assert.equal(parseReviewFindings(JSON.stringify([{ ...valid, ...change }])), null, JSON.stringify(change));
  }
  assert.equal(parseReviewFindings(JSON.stringify([valid, { ...valid, severity: 'unsupported' }])), null);
  assert.equal(parseReviewFindings(JSON.stringify(Array(101).fill(valid))), null);
  assert.equal(parseReviewFindings('x'.repeat(200_001)), null);
});
