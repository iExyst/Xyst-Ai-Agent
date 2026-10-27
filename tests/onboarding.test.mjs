import test from 'node:test';
import assert from 'node:assert/strict';
import { localProfileFromDiscovery } from '../gui/onboarding.mjs';

test('first-run setup creates a unique local compatible model profile', () => {
  const server = { name: 'LM Studio', base_url: 'http://127.0.0.1:1234/v1', model_context_lengths: { 'qwen/test': 8192 } };
  const first = localProfileFromDiscovery(server, 'qwen/test');
  assert.equal(first.name, 'lm-studio-qwen-test');
  assert.deepEqual(first.profile, {
    provider: 'openai-compatible',
    base_url: 'http://127.0.0.1:1234/v1',
    model: 'qwen/test',
    local: true,
    supports_tools: true,
    context_length: 8192,
  });
  assert.equal(localProfileFromDiscovery(server, 'qwen/test', { [first.name]: {} }).name, `${first.name}-2`);
});

test('first-run model setup uses only explicitly reported tool and vision capabilities', () => {
  const server = {
    name: 'LM Studio',
    base_url: 'http://127.0.0.1:1234/v1',
    model_capabilities: {
      'qwen/tool': { supports_tools: true, supports_vision: false },
      'qwen/text-only': { supports_tools: false, supports_vision: true },
      'qwen/unknown': { supports_tools: 'yes', supports_vision: null },
    },
  };
  assert.deepEqual(localProfileFromDiscovery(server, 'qwen/tool').profile, {
    provider: 'openai-compatible',
    base_url: server.base_url,
    model: 'qwen/tool',
    local: true,
    supports_tools: true,
    supports_vision: false,
  });
  assert.equal(localProfileFromDiscovery(server, 'qwen/text-only').profile.supports_tools, false);
  assert.equal(localProfileFromDiscovery(server, 'qwen/text-only').profile.supports_vision, true);
  assert.equal(localProfileFromDiscovery(server, 'qwen/unknown').profile.supports_tools, true);
  assert.equal(localProfileFromDiscovery(server, 'qwen/unknown').profile.supports_vision, undefined);
});

test('first-run setup ignores invalid model context metadata', () => {
  for (const contextLength of [0, -1, '8192', Number.MAX_SAFE_INTEGER + 1, 10_000_001]) {
    const { profile } = localProfileFromDiscovery(
      { name: 'LM Studio', base_url: 'http://127.0.0.1:1234/v1', model_context_lengths: { model: contextLength } },
      'model',
    );
    assert.equal(profile.context_length, undefined);
  }
});

test('first-run setup rejects non-loopback and credential-bearing endpoints', () => {
  assert.throws(() => localProfileFromDiscovery({ name: 'remote', base_url: 'https://example.com/v1' }, 'm'), /loopback/);
  assert.throws(() => localProfileFromDiscovery({ name: 'local', base_url: 'http://user:pass@127.0.0.1/v1' }, 'm'), /unsupported/);
  assert.throws(() => localProfileFromDiscovery({ name: 'local', base_url: 'http://127.0.0.1/v1?key=x' }, 'm'), /unsupported/);
  assert.throws(() => localProfileFromDiscovery({ name: 'local', base_url: 'http://127.0.0.1/v1' }, 'x'.repeat(201)), /Model ID/);
});
