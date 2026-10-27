import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ObservabilityEventStore } from '../src/observability/event-store.mjs';
import { createSymlinkOrSkip, createTempDirectory } from './helpers.mjs';

const CORRELATION_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ID = '00000000-0000-4000-8000-000000000003';

test('observability is opt-in and writes a bounded allowlist without prompt, path, or payload data', async (t) => {
  const root = await createTempDirectory('xyst-observability-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const disabled = new ObservabilityEventStore(root);
  await disabled.record({ correlationId: CORRELATION_ID, runId: RUN_ID, event: { type: 'run_started' } });
  await assert.rejects(fs.stat(path.join(root, '.agent', 'observability', 'events.jsonl')), { code: 'ENOENT' });

  const store = new ObservabilityEventStore(root, { enabled: true });
  await Promise.all([
    store.record({
      correlationId: CORRELATION_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      event: {
        sequence: 7,
        type: 'tool_started',
        timestamp: '2026-10-21T12:00:00.000Z',
        tool: 'write_file',
        turn: 2,
        prompt: 'PROMPT_CANARY',
        path: 'C:\\private\\file.txt',
        arguments: { content: 'PAYLOAD_CANARY', api_key: 'SECRET_CANARY' },
      },
    }),
    store.record({
      correlationId: CORRELATION_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      event: {
        type: 'model_call_finished',
        usage: { inputTokens: 42, outputTokens: 9, cachedInputTokens: 12 },
        estimated_cost: 0.002,
        duration_ms: 15,
      },
    }),
  ]);
  await store.flush();
  const content = await fs.readFile(store.file, 'utf8');
  assert.doesNotMatch(content, /PROMPT_CANARY|PAYLOAD_CANARY|SECRET_CANARY|private|arguments|api_key/);
  const records = content
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].correlation_id, CORRELATION_ID);
  assert.equal(records[0].run_id, RUN_ID);
  assert.equal(records[0].session_id, SESSION_ID);
  assert.equal(records[0].event, 'tool_started');
  assert.equal(records[0].sequence, 7);
  assert.equal(records[0].tool, 'write_file');
  assert.equal(records[0].turn, 2);
  assert.deepEqual(Object.keys(records[0]).sort(), [
    'correlation_id',
    'event',
    'run_id',
    'schema_version',
    'sequence',
    'session_id',
    'timestamp',
    'tool',
    'turn',
  ]);
  assert.equal(records[1].input_tokens, 42);
  assert.equal(records[1].output_tokens, 9);
  assert.equal(records[1].cached_input_tokens, 12);
  assert.equal(records[1].estimated_cost_usd, 0.002);
  assert.equal(records[1].duration_ms, 15);
  if (process.platform !== 'win32') assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
});

test('opt-in console export writes only the same sanitized lifecycle record as the local file', async (t) => {
  const root = await createTempDirectory('xyst-observability-console-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lines = [];
  const disabled = new ObservabilityEventStore(root, {
    consoleEnabled: true,
    consoleWriter: (line) => lines.push(line),
  });
  await disabled.record({ correlationId: CORRELATION_ID, runId: RUN_ID, event: { type: 'run_started' } });
  assert.deepEqual(lines, []);

  const store = new ObservabilityEventStore(root, {
    enabled: true,
    consoleEnabled: true,
    consoleWriter: (line) => lines.push(line),
  });
  await store.record({
    correlationId: CORRELATION_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    event: {
      type: 'tool_started',
      tool: 'write_file',
      prompt: 'CONSOLE_PROMPT_CANARY',
      path: 'C:\\private\\console.txt',
      arguments: { content: 'CONSOLE_PAYLOAD_CANARY', api_key: 'CONSOLE_SECRET_CANARY' },
    },
  });
  await store.flush();

  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n'));
  assert.doesNotMatch(lines[0], /CONSOLE_PROMPT_CANARY|CONSOLE_PAYLOAD_CANARY|CONSOLE_SECRET_CANARY|private|arguments/);
  assert.deepEqual(JSON.parse(lines[0]), JSON.parse(await fs.readFile(store.file, 'utf8')));
});

test('observability store ignores unapproved event types and refuses symlinked state directories', async (t) => {
  const root = await createTempDirectory('xyst-observability-link-root-');
  const outside = await createTempDirectory('xyst-observability-link-outside-');
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const store = new ObservabilityEventStore(root, { enabled: true });
  assert.equal(
    await store.record({ correlationId: CORRELATION_ID, runId: RUN_ID, event: { type: 'assistant_delta', text: 'must not be recorded' } }),
    false,
  );
  await fs.mkdir(path.join(outside, 'observability'));
  if (!(await createSymlinkOrSkip(t, outside, path.join(root, '.agent')))) return;
  await assert.rejects(store.record({ correlationId: CORRELATION_ID, runId: RUN_ID, event: { type: 'run_started' } }), {
    code: 'OBSERVABILITY_PATH_UNSAFE',
  });
  assert.deepEqual(await fs.readdir(path.join(outside, 'observability')), []);
});

test('observability retains only the active file and one bounded prior file', async (t) => {
  const root = await createTempDirectory('xyst-observability-rotation-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ObservabilityEventStore(root, { enabled: true, maxFileBytes: 1_000 });
  for (let index = 0; index < 12; index += 1) {
    await store.record({
      correlationId: CORRELATION_ID,
      runId: RUN_ID,
      event: { type: 'run_started', model: `model-${index}` },
    });
  }
  const active = await fs.readFile(store.file, 'utf8');
  const previous = await fs.readFile(store.previousFile, 'utf8');
  assert.ok(Buffer.byteLength(active) <= 1_000);
  assert.ok(Buffer.byteLength(previous) <= 1_000);
  assert.equal(JSON.parse(active.trim().split('\n').at(-1)).model, 'model-11');
  assert.ok((await fs.readdir(store.directory)).every((name) => ['events.jsonl', 'events.1.jsonl'].includes(name)));
});
