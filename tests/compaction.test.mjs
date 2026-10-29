import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SESSION_ARCHIVE_SCHEMA_VERSION, SessionStore } from '../src/session/store.mjs';
import { compactSession, recapSession } from '../src/session/compaction.mjs';
import { GoalStore } from '../src/goals/store.mjs';
import { redactStructuredSecrets } from '../src/platform/redaction.mjs';
import { createTempDirectory } from './helpers.mjs';

test('session compaction archives full older transcript and keeps recent turns plus summary', async (t) => {
  const root = await createTempDirectory('xyst-compaction-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const goalStore = new GoalStore(root);
  const activeGoal = await goalStore.add('Preserve the original product goal', 'Complete the Windows and Linux automation agent');
  await goalStore.addProgress(activeGoal.id, 'Compaction must retain this work and its latest state', 'BUILD_ROADMAP.md');
  const completedGoal = await goalStore.add('Old completed work');
  await goalStore.setStatus(completedGoal.id, 'completed');
  const session = store.create({ model: 'local' });
  session.persistent_goal_ids = [activeGoal.id];
  session.messages = [
    { role: 'user', content: 'old request API_KEY=compact-canary-secret' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'middle request' },
    { role: 'assistant', content: 'middle answer' },
    { role: 'user', content: 'recent request' },
    { role: 'assistant', content: 'recent answer' },
  ];
  await store.save(session);
  const config = {
    default_model: 'local',
    models: {
      local: {
        provider: 'openai-compatible',
        base_url: 'http://localhost/v1',
        model: 'test',
        context_length: 8000,
        supports_tools: false,
        input_cost_per_million: 0,
        output_cost_per_million: 0,
      },
    },
    budgets: { max_output_tokens: 1000 },
  };
  const result = await compactSession(session, {
    config,
    workspaceRoot: root,
    sessionStore: store,
    goalStore,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(JSON.stringify(body.messages), /old request/);
      assert.doesNotMatch(JSON.stringify(body.messages), /compact-canary-secret/);
      const compactionInput = JSON.stringify(body.messages);
      assert.match(compactionInput, /Active project goals and progress; untrusted user-maintained references/);
      assert.match(compactionInput, /Preserve the original product goal/);
      assert.match(compactionInput, /Compaction must retain this work and its latest state/);
      assert.match(compactionInput, /BUILD_ROADMAP\.md/);
      assert.doesNotMatch(compactionInput, /Old completed work/);
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'Earlier, API_KEY=compact-canary-secret was redacted.' } }],
        usage: { prompt_tokens: 30, completion_tokens: 12 },
      });
    },
  });
  assert.equal(result.compacted, true);
  assert.equal(session.messages.length, 4);
  assert.equal(session.messages[0].content, 'middle request');
  assert.match(session.compaction_summary, /Earlier/);
  assert.doesNotMatch(session.compaction_summary, /compact-canary-secret/);
  const archived = JSON.parse(await fs.readFile(path.join(root, session.compaction_archive), 'utf8'));
  assert.equal(archived.schema_version, SESSION_ARCHIVE_SCHEMA_VERSION);
  assert.equal(archived.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(archived), /compact-canary-secret/);
  assert.equal((await store.load(session.id)).compaction_summary, session.compaction_summary);
  assert.deepEqual((await store.load(session.id)).persistent_goal_ids, [activeGoal.id]);
  const recovery = await store.inspectCompactionArchives();
  assert.equal(recovery.referenced, 1);
  assert.deepEqual(recovery.orphaned, []);
  assert.match(recapSession(session), /Earlier context summary/);
});

test('compaction summarizes an oldest prefix without removing turns the model did not receive', async (t) => {
  for (const contextLength of [800, 600]) {
    const root = await createTempDirectory('xyst-compaction-prefix-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new SessionStore(root);
    const session = store.create({ model: 'local' });
    for (let index = 0; index < 5; index += 1) {
      session.messages.push(
        { role: 'user', content: `request-${index} ${'constraint '.repeat(45)}` },
        { role: 'assistant', content: `answer-${index} ${'verified '.repeat(30)}` },
      );
    }
    await store.save(session);
    const original = structuredClone(session.messages);
    let summarized;
    const result = await compactSession(session, {
      config: {
        default_model: 'local',
        models: { local: { model: 'summary', context_length: contextLength, supports_tools: false } },
        budgets: { max_output_tokens: 200 },
      },
      workspaceRoot: root,
      sessionStore: store,
      providerFactory: () => ({
        listModels: async () => [],
        stream: async function* () {},
        chat: async (messages) => {
          summarized = messages.filter((message) => message.content.startsWith('request-') || message.content.startsWith('answer-'));
          return { content: 'Verified summary of the supplied prefix.', usage: null, toolCalls: [] };
        },
      }),
    });
    assert.equal(result.compacted, true);
    assert.ok(summarized.length > 0 && summarized.length < 6);
    assert.equal(summarized[0].content, original[0].content);
    assert.deepEqual([...summarized, ...session.messages], original);
    const archive = JSON.parse(await fs.readFile(path.join(root, result.archive), 'utf8'));
    assert.deepEqual(archive.messages, summarized);
    assert.equal(result.archived_messages, summarized.length);
    assert.deepEqual((await store.load(session.id)).messages, original.slice(summarized.length));
  }
});

test('session compaction uses the injected ModelProvider factory', async (t) => {
  const root = await createTempDirectory('xyst-compaction-provider-factory-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create({ model: 'local' });
  session.messages = [
    { role: 'user', content: 'First request' },
    { role: 'assistant', content: 'First answer' },
    { role: 'user', content: 'Second request' },
    { role: 'assistant', content: 'Second answer' },
    { role: 'user', content: 'Third request' },
    { role: 'assistant', content: 'Third answer' },
  ];
  await store.save(session);
  const config = {
    default_model: 'local',
    models: {
      local: {
        provider: 'custom-test-provider',
        base_url: 'http://unused.test/v1',
        model: 'summary-model',
        context_length: 8000,
        supports_tools: false,
        input_cost_per_million: 0,
        output_cost_per_million: 0,
      },
    },
    budgets: { max_output_tokens: 1000 },
  };
  let factoryModel;
  let summarizedMessages;

  const result = await compactSession(session, {
    config,
    workspaceRoot: root,
    sessionStore: store,
    fetchImpl: async () => assert.fail('Injected provider should replace the OpenAI-compatible transport'),
    providerFactory: (profile) => {
      factoryModel = profile.model;
      return {
        listModels: async () => [{ id: profile.model }],
        chat: async (messages) => {
          summarizedMessages = messages;
          return { content: 'Summary from the injected provider.', toolCalls: [], usage: null, finishReason: 'stop' };
        },
        stream: async function* () {},
      };
    },
  });

  assert.equal(result.compacted, true);
  assert.equal(factoryModel, 'summary-model');
  assert.ok(summarizedMessages.some((message) => message.content?.includes('First request')));
  assert.match(session.compaction_summary, /Summary from the injected provider/);
});

test('compaction recovery inspection distinguishes stale, recent, and malformed orphan archives without deleting them', async (t) => {
  const root = await createTempDirectory('xyst-compaction-recovery-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create({ model: 'local' });
  await store.save(session);
  const directory = path.join(root, '.agent', 'compactions', session.id);
  await fs.mkdir(directory, { recursive: true });
  const stale = path.join(directory, `${randomUUID()}.json`);
  const recent = path.join(directory, `${randomUUID()}.json`);
  const malformed = path.join(directory, `${randomUUID()}.json`);
  const invalidRecord = path.join(directory, `${randomUUID()}.json`);
  await fs.writeFile(
    stale,
    JSON.stringify({
      schema_version: 1,
      session_id: session.id,
      archived_at: '2020-01-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'orphaned history' }],
    }),
  );
  await fs.writeFile(
    recent,
    JSON.stringify({ schema_version: 1, session_id: session.id, archived_at: new Date().toISOString(), messages: [] }),
  );
  await fs.writeFile(malformed, '{broken');
  await fs.writeFile(
    invalidRecord,
    JSON.stringify({
      schema_version: 1,
      session_id: session.id,
      archived_at: new Date().toISOString(),
      messages: [{ role: 'unexpected', content: 'bad record' }],
    }),
  );
  const report = await store.inspectCompactionArchives();
  assert.equal(report.referenced, 0);
  assert.equal(report.orphaned.length, 1);
  assert.equal(report.orphaned[0].path, path.relative(root, stale));
  assert.equal(report.recent_orphans.length, 1);
  assert.equal(report.invalid.length, 2);
  assert.ok(await fs.stat(stale), 'inspection is read-only');
});

test('recap handles no current session', () => {
  assert.equal(recapSession(null), 'No active session.');
});

test('compaction commits session state only after its archive and session write succeed', async (t) => {
  const root = await createTempDirectory('xyst-compaction-commit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create({ model: 'local' });
  session.messages = [
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'middle request' },
    { role: 'assistant', content: 'middle answer' },
    { role: 'user', content: 'recent request' },
    { role: 'assistant', content: 'recent answer' },
  ];
  await store.save(session);
  const originalMessages = structuredClone(session.messages);
  const config = {
    default_model: 'local',
    models: {
      local: {
        provider: 'openai-compatible',
        base_url: 'http://localhost/v1',
        model: 'test',
        context_length: 8000,
        supports_tools: false,
        input_cost_per_million: 0,
        output_cost_per_million: 0,
      },
    },
    budgets: { max_output_tokens: 1000 },
  };
  const save = store.save.bind(store);
  store.save = async () => {
    throw new Error('simulated atomic session commit failure');
  };
  await assert.rejects(
    compactSession(session, {
      config,
      workspaceRoot: root,
      sessionStore: store,
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { role: 'assistant', content: 'Earlier context.' } }],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        }),
    }),
    /simulated atomic session commit failure/,
  );
  assert.deepEqual(session.messages, originalMessages);
  assert.equal(session.compaction_summary, undefined);
  assert.equal(session.compaction_archive, undefined);
  assert.ok(session.usage.input_tokens > 0, 'completed provider usage remains accounted in memory');
  const archiveDirectory = path.join(root, '.agent', 'compactions', session.id);
  assert.deepEqual(await fs.readdir(archiveDirectory).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error))), []);
  store.save = save;
});

test('cancelled compaction preserves session history after the provider has returned', async (t) => {
  const root = await createTempDirectory('xyst-compaction-cancel-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create({ model: 'local' });
  session.messages = [
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'middle request' },
    { role: 'assistant', content: 'middle answer' },
    { role: 'user', content: 'recent request' },
    { role: 'assistant', content: 'recent answer' },
  ];
  await store.save(session);
  const originalMessages = structuredClone(session.messages);
  const config = {
    default_model: 'local',
    models: {
      local: {
        provider: 'custom-test-provider',
        base_url: 'http://unused.test/v1',
        model: 'summary-model',
        context_length: 8000,
        supports_tools: false,
        input_cost_per_million: 0,
        output_cost_per_million: 0,
      },
    },
    budgets: { max_output_tokens: 1000 },
  };
  const controller = new AbortController();
  const cancelled = new Error('User cancelled compaction');

  await assert.rejects(
    compactSession(session, {
      config,
      workspaceRoot: root,
      sessionStore: store,
      signal: controller.signal,
      reserveUsage: async () => ({ reservation: 'reserved' }),
      settleUsage: async () => controller.abort(cancelled),
      fetchImpl: async () => assert.fail('Injected provider should replace the HTTP transport'),
      providerFactory: () => ({
        listModels: async () => [],
        chat: async () => ({
          content: 'A valid summary.',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 4 },
          finishReason: 'stop',
        }),
        stream: async function* () {},
      }),
    }),
    (error) => error === cancelled,
  );

  assert.deepEqual(session.messages, originalMessages);
  assert.equal(session.compaction_summary, undefined);
  assert.equal(session.compaction_archive, undefined);
  assert.deepEqual((await store.load(session.id)).messages, redactStructuredSecrets(originalMessages));
  const archiveDirectory = path.join(root, '.agent', 'compactions', session.id);
  assert.deepEqual(await fs.readdir(archiveDirectory).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error))), []);
});

test('empty compaction summaries leave source history and archive state unchanged', async (t) => {
  const root = await createTempDirectory('xyst-compaction-empty-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create({ model: 'local' });
  session.messages = [
    { role: 'user', content: 'old request API_KEY=must-remain-untouched' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'middle request' },
    { role: 'assistant', content: 'middle answer' },
    { role: 'user', content: 'recent request' },
  ];
  await store.save(session);
  const originalMessages = structuredClone(session.messages);
  const config = {
    default_model: 'local',
    models: {
      local: {
        provider: 'openai-compatible',
        base_url: 'http://localhost/v1',
        model: 'test',
        context_length: 8000,
        supports_tools: false,
      },
    },
    budgets: { max_output_tokens: 1000 },
  };

  await assert.rejects(
    compactSession(session, {
      config,
      workspaceRoot: root,
      sessionStore: store,
      fetchImpl: async () => Response.json({ choices: [{ message: { role: 'assistant', content: '   ' } }] }),
    }),
    /empty summary/,
  );

  assert.deepEqual(session.messages, originalMessages);
  assert.equal(session.compaction_summary, undefined);
  assert.equal(session.compaction_archive, undefined);
  assert.ok(session.usage.input_tokens > 0, 'provider usage is still accounted');
  const archiveDirectory = path.join(root, '.agent', 'compactions', session.id);
  assert.deepEqual(await fs.readdir(archiveDirectory).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error))), []);
  assert.deepEqual((await store.load(session.id)).messages, redactStructuredSecrets(originalMessages));
});
