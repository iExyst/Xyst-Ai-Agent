import assert from 'node:assert/strict';
import test from 'node:test';
import { markDiscoveredModelLoaded, postLoadModelChoice } from '../gui/onboarding.mjs';

function choice(model = 'qwen-test', baseUrl = 'http://127.0.0.1:1234/v1') {
  return { model, server: { name: 'lm-studio', base_url: baseUrl } };
}

test('model loading updates the discovered loaded state and safe context length', () => {
  const discovered = choice();
  markDiscoveredModelLoaded(discovered, { context_length: 8192 });
  assert.equal(discovered.server.model_states['qwen-test'], 'loaded');
  assert.equal(discovered.server.model_context_lengths['qwen-test'], 8192);
});

test('model loading preserves known context when LM Studio omits it', () => {
  const discovered = choice();
  discovered.server.model_context_lengths = { 'qwen-test': 4096 };
  markDiscoveredModelLoaded(discovered, { loaded: true });
  assert.equal(discovered.server.model_states['qwen-test'], 'loaded');
  assert.equal(discovered.server.model_context_lengths['qwen-test'], 4096);
});

test('loading an already configured profile does not select it as the default', () => {
  const configured = choice();
  const sameModel = choice();
  assert.equal(postLoadModelChoice(configured, [sameModel], true), null);
});

test('loading a new model connects the refreshed choice or the original if discovery is briefly empty', () => {
  const original = choice();
  const refreshed = choice();
  const otherServer = choice('qwen-test', 'http://127.0.0.1:8000/v1');
  assert.equal(postLoadModelChoice(original, [otherServer, refreshed], false), refreshed);
  assert.equal(postLoadModelChoice(original, [], false), original);
});
