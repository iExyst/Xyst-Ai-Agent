import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleEmbeddingProvider } from '../src/providers/embeddings.mjs';

test('OpenAI-compatible embedding adapter sends bounded inputs and restores vector order', async () => {
  let request;
  const provider = new OpenAICompatibleEmbeddingProvider({
    baseUrl: 'http://127.0.0.1:1234/v1/',
    model: 'embed-model',
    apiKey: 'secret-value',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      });
    },
  });
  assert.deepEqual(await provider.embed(['first', 'second']), [
    [1, 0],
    [0, 1],
  ]);
  assert.equal(request.url, 'http://127.0.0.1:1234/v1/embeddings');
  assert.equal(request.options.headers.authorization, 'Bearer secret-value');
  assert.deepEqual(JSON.parse(request.options.body), { model: 'embed-model', input: ['first', 'second'] });
});

test('embedding adapter rejects oversized, missing, inconsistent, and non-finite vectors', async () => {
  const provider = new OpenAICompatibleEmbeddingProvider({
    baseUrl: 'http://localhost/v1',
    model: 'embed',
    fetchImpl: async () => Response.json({ data: [{ index: 0, embedding: [1, Infinity] }] }),
  });
  await assert.rejects(provider.embed(['x']), { code: 'INVALID_RESPONSE' });
  await assert.rejects(provider.embed(['x'.repeat(16_001)]), /at most 16000 bytes/);
  assert.throws(
    () => new OpenAICompatibleEmbeddingProvider({ baseUrl: 'https://user:pass@remote.test/v1', model: 'embed' }),
    /without credentials/,
  );
});

test('embedding adapter rejects malformed JSON roots and null vector entries with a stable error code', async () => {
  for (const payload of [null, [], 'unexpected', { data: [null] }]) {
    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'http://localhost/v1',
      model: 'embed',
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(provider.embed(['x']), (error) => error.code === 'INVALID_RESPONSE');
  }

  const invalidUtf8 = new OpenAICompatibleEmbeddingProvider({
    baseUrl: 'http://localhost/v1',
    model: 'embed',
    fetchImpl: async () => new Response(Uint8Array.of(0xff)),
  });
  await assert.rejects(invalidUtf8.embed(['x']), (error) => error.code === 'INVALID_RESPONSE');
});

test('embedding adapter reports provider usage and falls back to a bounded token estimate', async () => {
  const usage = [];
  const provider = new OpenAICompatibleEmbeddingProvider({
    baseUrl: 'http://localhost/v1',
    model: 'embed',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })), usage: { prompt_tokens: 13 } });
    },
  });
  await provider.embed(['first text', 'second text'], { onUsage: (item) => usage.push(item) });
  assert.deepEqual(usage, [
    {
      inputTokens: 13,
      outputTokens: 0,
      inputTokenSource: 'provider_reported',
      outputTokenSource: 'estimated',
      model: 'embed',
    },
  ]);

  const estimated = [];
  const fallback = new OpenAICompatibleEmbeddingProvider({
    baseUrl: 'http://localhost/v1',
    model: 'embed',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    },
  });
  await fallback.embed(['12345'], { onUsage: (item) => estimated.push(item) });
  assert.equal(estimated[0].inputTokens, 2);
  assert.equal(estimated[0].inputTokenSource, 'estimated');
});
