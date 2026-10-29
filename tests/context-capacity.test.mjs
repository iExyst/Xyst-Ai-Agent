import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveContextCapacity } from '../src/providers/context-capacity.mjs';
import { validateRuntimeOverrides } from '../src/config/runtime-overrides.mjs';

const profile = { base_url: 'http://192.168.1.50:1234/v1', model: 'coding-model', context_length: 8192 };

test('automatic context follows the remote loaded instance rather than stale saved context or theoretical maximum', async () => {
  const calls = [];
  const result = await resolveContextCapacity(profile, {
    apiKey: 'test-auth',
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.authorization, 'Bearer test-auth');
      assert.equal(options.redirect, 'error');
      if (url.endsWith('/api/v1/models'))
        return Response.json({
          models: [
            { key: 'unrelated', loaded_instances: [{ config: { context_length: 1024 } }] },
            { key: 'coding-model', max_context_length: 1000000, loaded_instances: [{ config: { context_length: 131072 } }] },
          ],
        });
      return new Response('', { status: 404 });
    },
  });
  assert.equal(result.context_length, 131072);
  assert.equal(result.source, 'lm-studio-loaded');
  assert.ok(calls.every((url) => url.startsWith('http://192.168.1.50:1234/')));
});

test('automatic context caps capable hosts at 250000 and uses the smallest routable loaded instance', async () => {
  for (const [lengths, expected] of [
    [[262144], 250000],
    [[32768, 8192], 8192],
  ]) {
    const result = await resolveContextCapacity(profile, {
      fetchImpl: async (url) =>
        url.endsWith('/api/v1/models')
          ? Response.json({
              models: [{ key: profile.model, loaded_instances: lengths.map((context_length) => ({ config: { context_length } })) }],
            })
          : new Response('', { status: 404 }),
    });
    assert.equal(result.context_length, expected);
  }
});

test('automatic context reads Ollama active capacity rather than model training capacity', async () => {
  const result = await resolveContextCapacity(
    { ...profile, base_url: 'http://127.0.0.1:11434/v1' },
    {
      fetchImpl: async (url) =>
        url.endsWith('/api/ps')
          ? Response.json({ models: [{ name: 'coding-model:latest', context_length: 16384 }] })
          : new Response('', { status: 404 }),
    },
  );
  assert.equal(result.context_length, 16384);
  assert.equal(result.source, 'ollama-loaded');
});

test('provider capacity metadata and missing telemetry have bounded fallbacks', async () => {
  const result = await resolveContextCapacity(
    { ...profile, base_url: 'https://model.example/proxy/v1', context_length: 500000 },
    {
      fetchImpl: async (url) => {
        assert.equal(url, 'https://model.example/proxy/v1/models');
        return Response.json({ data: [{ id: 'coding-model', max_model_len: 64000 }] });
      },
    },
  );
  assert.equal(result.context_length, 64000);
  const fallback = await resolveContextCapacity(profile, {
    fetchImpl: async () => {
      throw new Error('No metadata');
    },
  });
  assert.equal(fallback.context_length, 8192);
  assert.equal(fallback.source, 'configured-fallback');
  const unknown = await resolveContextCapacity(
    { ...profile, context_length: 500000 },
    {
      fetchImpl: async () => Response.json({ models: [null], data: {} }),
    },
  );
  assert.equal(unknown.context_length, 8192, 'unavailable or malformed telemetry cannot justify an oversized allocation');
});

test('manual mode stays explicit and metadata cancellation remains cancellation', async () => {
  const manual = await resolveContextCapacity(
    { ...profile, context_mode: 'manual', context_length: 4096 },
    {
      fetchImpl: async () => {
        assert.fail('Manual mode must not probe');
      },
    },
  );
  assert.equal(manual.context_length, 4096);
  const controller = new AbortController();
  controller.abort(new Error('User cancelled'));
  await assert.rejects(
    resolveContextCapacity(profile, {
      signal: controller.signal,
      fetchImpl: async () => {
        throw new Error('Aborted');
      },
    }),
    /User cancelled/,
  );
  validateRuntimeOverrides({ models: { local: { context_mode: 'auto' } } });
  assert.throws(() => validateRuntimeOverrides({ models: { local: { context_mode: 'unlimited' } } }), /context_mode/);
});
