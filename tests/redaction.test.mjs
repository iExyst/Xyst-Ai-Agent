import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { redactSecrets, redactStructuredSecrets } from '../src/platform/redaction.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { createTempDirectory } from './helpers.mjs';

test('structured secret redaction removes values under secret-named fields but keeps references and identifiers', () => {
  const redacted = redactStructuredSecrets({
    api_key: 'raw-api-key-canary',
    nested: { refresh_token: 'raw-refresh-token-canary', password: 1234, optional_secret: null },
    api_key_secret: 'vault-reference-name',
    key_id: 'trusted-key-identifier',
    input_tokens: 12,
    output_tokens: 34,
    token_value: 'raw-token-value-canary',
    ordinary: 'visible content',
  });
  assert.deepEqual(redacted, {
    api_key: '[REDACTED]',
    nested: { refresh_token: '[REDACTED]', password: '[REDACTED]', optional_secret: null },
    api_key_secret: 'vault-reference-name',
    key_id: 'trusted-key-identifier',
    input_tokens: 12,
    output_tokens: 34,
    token_value: '[REDACTED]',
    ordinary: 'visible content',
  });
  assert.doesNotMatch(JSON.stringify(redacted), /raw-api-key-canary|raw-refresh-token-canary/);
});

test('text redaction recognizes camel-case credentials, authorization headers, and quoted JSON keys', () => {
  assert.equal(redactSecrets('apiKey: raw-canary'), 'apiKey: [REDACTED]');
  assert.equal(redactSecrets('Authorization: Bearer bearer-canary'), 'Authorization: [REDACTED]');
  assert.equal(redactSecrets('{"AWS_SECRET_ACCESS_KEY":"json-canary"}'), '{"AWS_SECRET_ACCESS_KEY":"[REDACTED]"}');
  assert.equal(redactSecrets('api_key_secret: vault-entry key_id: publisher-key'), 'api_key_secret: vault-entry key_id: publisher-key');
  const toolArguments = JSON.stringify({ path: 'config.txt', content: 'API_KEY=embedded-json-canary' });
  const redactedArguments = redactSecrets(toolArguments);
  assert.doesNotMatch(redactedArguments, /embedded-json-canary/);
  assert.equal(JSON.parse(redactedArguments).content, 'API_KEY=[REDACTED]');
  assert.equal(redactSecrets('{  "ordinary": "value" }'), '{  "ordinary": "value" }');
  assert.equal(redactStructuredSecrets({ accessTokenValue: 'token-value-canary' }).accessTokenValue, '[REDACTED]');
});

test('portable session export redacts structured credential fields nested in message data', async (t) => {
  const workspace = await createTempDirectory('xyst-structured-secret-export-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const store = new SessionStore(workspace);
  const session = store.create({
    messages: [
      {
        role: 'assistant',
        content: 'tool result received',
        debug: { provider: { api_key: 'session-export-canary' }, credential_ref: 'vault-entry' },
      },
    ],
  });
  await store.save(session);

  const exported = await store.exportSession(session.id);
  const serialized = JSON.stringify(exported);
  assert.doesNotMatch(serialized, /session-export-canary/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /vault-entry/);
});
