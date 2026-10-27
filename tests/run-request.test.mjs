import test from 'node:test';
import assert from 'node:assert/strict';
import { validateControlApiRunRequest } from '../src/api/run-request.mjs';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

test('shared Control API run request validation accepts supported fields and optional values', () => {
  assert.equal(
    validateControlApiRunRequest({
      prompt: 'Inspect this workspace',
      session_id: UUID,
      model: 'local',
      mode: 'agent',
      worktree_id: UUID,
      mcp_servers: ['docs'],
      images: [],
    }),
    null,
  );
  assert.equal(validateControlApiRunRequest({ prompt: 'Start fresh', mcp_servers: null }), null);
});

test('shared Control API run request validation rejects malformed shapes and values', () => {
  assert.equal(validateControlApiRunRequest(null), 'Run body contains an unsupported property');
  assert.equal(validateControlApiRunRequest({ prompt: 'ok', unexpected: true }), 'Run body contains an unsupported property');
  assert.equal(validateControlApiRunRequest({ prompt: '  ' }), 'prompt must contain 1 to 100000 characters');
  assert.equal(validateControlApiRunRequest({ prompt: 'x'.repeat(100_001) }), 'prompt must contain 1 to 100000 characters');
  assert.equal(validateControlApiRunRequest({ prompt: 'ok', session_id: 'bad' }), 'session_id must be a valid session UUID');
  assert.equal(validateControlApiRunRequest({ prompt: 'ok', worktree_id: 'bad' }), 'worktree_id must be a valid worktree UUID');
  assert.equal(validateControlApiRunRequest({ prompt: 'ok', model: ' ' }), 'model must be a non-empty string of at most 200 characters');
  assert.equal(validateControlApiRunRequest({ prompt: 'ok', mode: 'unknown' }), 'mode must be agent, review, or plan');
  assert.match(validateControlApiRunRequest({ prompt: 'ok', mcp_servers: ['docs', 'docs'] }), /unique configured/);
  assert.match(validateControlApiRunRequest({ prompt: 'ok', mcp_servers: Array(17).fill('docs') }), /at most 16/);
  assert.match(validateControlApiRunRequest({ prompt: 'ok', images: Array(5).fill({}) }), /at most 4 attachments/);
});
