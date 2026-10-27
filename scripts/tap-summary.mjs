export function parseSkippedTests(tapOutput) {
  if (typeof tapOutput !== 'string') throw new TypeError('TAP output must be a string');
  const summary = tapOutput.match(/^# skipped (\d+)$/m);
  if (!summary) throw new Error('Node test output did not contain a TAP skipped-test summary');
  const skipped = [...tapOutput.matchAll(/^ok \d+ - (.+?) # SKIP(?: (.*))?$/gm)].map(([, name, reason]) => ({
    name,
    reason: reason || 'no skip reason supplied',
  }));
  const expectedCount = Number(summary[1]);
  if (skipped.length !== expectedCount)
    throw new Error(`TAP reported ${expectedCount} skipped tests, but ${skipped.length} skip records were parsed`);
  return skipped;
}

export function formatSkippedTests(skipped) {
  if (!Array.isArray(skipped)) throw new TypeError('Skipped tests must be an array');
  if (skipped.length === 0) return 'Skipped tests: none';
  return [`Skipped tests (${skipped.length}):`, ...skipped.map(({ name, reason }) => `  - ${name}: ${reason}`)].join('\n');
}
