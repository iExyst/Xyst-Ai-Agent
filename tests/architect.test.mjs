import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ArchitectReviewService,
  hasReviewEvidence,
  prepareReadOnlyReviewConfig,
  selectReviewTarget,
} from '../src/architect/review-service.mjs';
import { createTempDirectory } from './helpers.mjs';

test('Architect review routing selects only configured local profiles and preserves explicit routing policy', () => {
  const config = {
    architect: { allow_remote: false },
    default_model: 'remote-default',
    review_model: 'remote-reviewer',
    models: {
      'remote-default': { local: false, base_url: 'https://provider.example/v1' },
      'remote-reviewer': { local: false, base_url: 'https://provider.example/v1' },
      'local-general': { local: true, base_url: 'http://127.0.0.1:1234/v1' },
      'local-reviewer': { local: true, base_url: 'http://127.0.0.1:1234/v1' },
    },
    routing: { prefer_local: false, fallback_chain: ['remote-reviewer', 'local-reviewer'] },
  };

  const prepared = prepareReadOnlyReviewConfig(config);
  assert.deepEqual(Object.keys(prepared.models), ['local-general', 'local-reviewer']);
  assert.equal(prepared.default_model, 'local-general');
  assert.equal(prepared.review_model, null);
  assert.deepEqual(prepared.routing, { prefer_local: true, fallback_chain: ['local-reviewer'] });
  assert.equal(config.default_model, 'remote-default', 'preparing a review must not mutate the caller configuration');
  assert.deepEqual(config.routing.fallback_chain, ['remote-reviewer', 'local-reviewer']);

  const noFallback = prepareReadOnlyReviewConfig({
    architect: { allow_remote: false },
    default_model: 'local-general',
    review_model: 'local-reviewer',
    models: config.models,
    routing: { selection: 'balanced' },
  });
  assert.equal(noFallback.review_model, 'local-reviewer');
  assert.deepEqual(noFallback.routing, { selection: 'balanced', prefer_local: true });
  assert.equal(Object.hasOwn(noFallback.routing, 'fallback_chain'), false, 'do not synthesize a fallback chain that hides model ranking');

  const remoteAllowed = prepareReadOnlyReviewConfig({
    ...config,
    architect: { allow_remote: true },
  });
  assert.equal(remoteAllowed.models['remote-reviewer'].local, false);
  assert.equal(remoteAllowed.review_model, 'remote-reviewer');
  assert.notEqual(remoteAllowed, config, 'prepared review configuration should be isolated from its caller');
});

test('Architect stores redacted review reports and removes its run lock', async (t) => {
  const workspaceRoot = await createTempDirectory('xyst-architect-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  let previousReports = null;
  const service = new ArchitectReviewService({
    config: { architect: { enabled: false } },
    workspaceRoot,
    review: async ({ previousReports: history }) => {
      previousReports = history;
      return {
        status: 'complete',
        session_id: 'session-id',
        model: 'local',
        findings: [
          { severity: 'high', file: 'src/example.mjs', line: 4, description: 'api_key=private-value', evidence: 'A concrete issue' },
        ],
        content: 'One supported finding',
      };
    },
  });

  const report = await service.runOnce();
  assert.equal(report.status, 'complete');
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0].description, /\[REDACTED\]/);
  assert.equal((await service.listReports()).length, 1);
  assert.deepEqual(previousReports, []);
  await service.runOnce();
  assert.equal(previousReports.length, 1);
  await assert.rejects(fs.stat(path.join(workspaceRoot, '.agent', 'architect', 'review.lock')), { code: 'ENOENT' });
});

test('Architect lock acquisition failure preserves a replacement record with the same file identity', async (t) => {
  const workspaceRoot = await createTempDirectory('xyst-architect-lock-replacement-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const lockPath = path.join(workspaceRoot, '.agent', 'architect', 'review.lock');
  const service = new ArchitectReviewService({ config: { architect: {} }, workspaceRoot, review: async () => ({ status: 'complete' }) });
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] !== lockPath || args[1] !== 'wx') return handle;
    return {
      writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
      sync: async () => {
        await handle.sync();
        await fs.writeFile(lockPath, JSON.stringify({ token: 'replacement-lock' }));
        throw Object.assign(new Error('injected sync failure'), { code: 'EIO' });
      },
      stat: () => handle.stat(),
      close: () => handle.close(),
    };
  };
  try {
    await assert.rejects(service.runOnce(), { code: 'EIO' });
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).token, 'replacement-lock');
});

test('Architect stores reviewer failures as bounded reports', async (t) => {
  const workspaceRoot = await createTempDirectory('xyst-architect-failure-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const service = new ArchitectReviewService({
    config: { architect: {} },
    workspaceRoot,
    review: async () => {
      throw new Error('Provider unavailable');
    },
  });

  const report = await service.runOnce();
  assert.equal(report.status, 'failed');
  assert.equal(report.error, 'Provider unavailable');
  assert.equal((await service.listReports()).length, 1);
});

test('Architect remains stopped when its user-configured toggle is off', async (t) => {
  const workspaceRoot = await createTempDirectory('xyst-architect-disabled-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  let reviews = 0;
  const service = new ArchitectReviewService({
    config: { architect: { enabled: false, run_on_start: true } },
    workspaceRoot,
    review: async () => {
      reviews += 1;
      return { status: 'complete', findings: [] };
    },
  });

  assert.deepEqual(await service.start(), { enabled: false });
  assert.equal(service.enabled, false);
  assert.equal(await service.runOnce().then((report) => report.status), 'complete', 'manual runs remain available while scheduling is off');
  assert.equal(reviews, 1);
  assert.equal(service.timer, null);
});

test('Architect rejects directory listings as review evidence', () => {
  assert.equal(
    hasReviewEvidence(
      { messages: [{ role: 'assistant', tool_calls: [{ function: { name: 'list_dir', arguments: '{"path":"."}' } }] }] },
      { source: 'src/core/agent.mjs', test: 'tests/agent.test.mjs' },
    ),
    false,
  );
});

test('Architect requires successful reads of the assigned source and paired test files', () => {
  const target = { source: 'src/core/agent.mjs', test: 'tests/agent.test.mjs' };
  const read = (id, file, content) => [
    {
      role: 'assistant',
      tool_calls: [{ id, function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } }],
    },
    {
      role: 'tool',
      tool_call_id: id,
      content: JSON.stringify({
        type: 'untrusted_observation',
        source: { kind: 'tool', name: 'read_file', tool_call_id: id },
        content,
      }),
    },
  ];
  const success = (file) => ({ path: file, start_line: 1, end_line: 1, content: 'file contents' });

  assert.equal(
    hasReviewEvidence(
      {
        messages: [
          ...read('source', target.source, success(target.source)),
          ...read('test', 'tests/tools.test.mjs', success('tests/tools.test.mjs')),
        ],
      },
      target,
    ),
    false,
  );
  assert.equal(
    hasReviewEvidence(
      { messages: [...read('source', target.source, { error: 'missing' }), ...read('test', target.test, success(target.test))] },
      target,
    ),
    false,
  );
  assert.equal(
    hasReviewEvidence(
      {
        messages: [
          ...read('source', '/workspace/src/core/agent.mjs', success('/workspace/src/core/agent.mjs')),
          ...read('test', target.test, success(target.test)),
        ],
      },
      target,
    ),
    true,
  );
});

test('Architect rotates scheduled reviews across the repository source and test areas', async () => {
  const first = selectReviewTarget(24, 0);
  const laterInSlot = selectReviewTarget(24, 23 * 60 * 60 * 1_000);
  const nextSlot = selectReviewTarget(24, 24 * 60 * 60 * 1_000);
  const fullCycle = selectReviewTarget(24, 28 * 24 * 60 * 60 * 1_000);
  const targets = Array.from({ length: 28 }, (_, slot) => selectReviewTarget(24, slot * 24 * 60 * 60 * 1_000));
  assert.deepEqual(first, { source: 'src/core/agent.mjs', test: 'tests/agent.test.mjs' });
  assert.deepEqual(laterInSlot, first);
  assert.notDeepEqual(nextSlot, first);
  assert.deepEqual(fullCycle, first);
  assert.equal(new Set(targets.map(({ source }) => source)).size, 28);
  for (const { source, test: testFile } of targets) {
    await fs.access(path.join(process.cwd(), source));
    await fs.access(path.join(process.cwd(), testFile));
  }
  assert.throws(() => selectReviewTarget(0, 0), /intervalHours/);
});

test('Architect does not send repository content to a remote model unless allowed', async (t) => {
  const workspaceRoot = await createTempDirectory('xyst-architect-remote-policy-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const service = new ArchitectReviewService({
    config: {
      architect: { enabled: false, allow_remote: false },
      default_model: 'remote',
      models: { remote: { provider: 'openai-compatible', base_url: 'https://example.test/v1', model: 'remote-model' } },
    },
    workspaceRoot,
  });

  const report = await service.runOnce();
  assert.equal(report.status, 'failed');
  assert.match(report.error, /no configured local model/);
});

test('Architect runs only one review at a time and cancels it on stop', async (t) => {
  const workspaceRoot = await createTempDirectory('xyst-architect-concurrent-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  let entered;
  const reviewStarted = new Promise((resolve) => {
    entered = resolve;
  });
  const service = new ArchitectReviewService({
    config: { architect: { enabled: true, interval_hours: 1, run_on_start: false } },
    workspaceRoot,
    review: ({ signal }) =>
      new Promise((resolve, reject) => {
        entered();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        setTimeout(() => resolve({ status: 'complete' }), 30_000).unref();
      }),
  });

  await service.start();
  const first = service.runOnce();
  await reviewStarted;
  assert.deepEqual(await service.runOnce(), { status: 'skipped_busy' });
  await service.stop();
  assert.equal((await first).status, 'failed');
});
