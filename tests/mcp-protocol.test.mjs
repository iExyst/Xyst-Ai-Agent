import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMcpResultType } from '../src/tools/mcp-protocol.mjs';

test('MCP result type validation accepts complete and legacy results', () => {
  const complete = { resultType: 'complete', content: [] };
  const implicitComplete = { content: [] };
  assert.equal(validateMcpResultType(complete, { protocolVersion: '2026-07-28', method: 'tools/call' }), complete);
  assert.throws(
    () => validateMcpResultType(implicitComplete, { protocolVersion: '2026-07-28', serverName: 'fixture', method: 'tools/call' }),
    { code: 'MCP_INVALID_RESPONSE' },
  );
  assert.equal(validateMcpResultType(implicitComplete, { protocolVersion: '2025-11-25', method: 'tools/call' }), implicitComplete);
  assert.equal(validateMcpResultType({ resultType: 'task' }, { protocolVersion: '2025-11-25' }).resultType, 'task');
});

test('MCP tool-call results validate content blocks and standard flags', () => {
  const result = {
    resultType: 'complete',
    isError: false,
    content: [
      { type: 'text', text: 'ok' },
      { type: 'image', data: 'Zm9v', mimeType: 'image/png' },
      { type: 'audio', data: 'Zm9v', mimeType: 'audio/wav' },
      { type: 'resource_link', uri: 'file:///workspace/a.txt', name: 'a.txt' },
      { type: 'resource', resource: { uri: 'file:///workspace/a.txt', text: 'contents' } },
    ],
    structuredContent: { answer: 'ok' },
  };
  assert.equal(validateMcpResultType(result, { protocolVersion: '2026-07-28', serverName: 'fixture', method: 'tools/call' }), result);
  for (const invalid of [
    { resultType: 'complete', content: [{ type: 'text', text: 1 }] },
    { resultType: 'complete', content: [{ type: 'image', data: 'abc' }] },
    { resultType: 'complete', content: [{ type: 'image', data: 'A===', mimeType: 'image/png' }] },
    { resultType: 'complete', content: [{ type: 'audio', data: 'not base64', mimeType: 'audio/wav' }] },
    { resultType: 'complete', content: [{ type: 'resource', resource: { uri: 'file:///workspace/a.txt', blob: 42 } }] },
    { resultType: 'complete', content: [{ type: 'resource', resource: { uri: 'file:///workspace/a.txt', blob: 'not base64' } }] },
    { resultType: 'complete', content: [], isError: 'false' },
  ]) {
    assert.throws(() => validateMcpResultType(invalid, { protocolVersion: '2026-07-28', serverName: 'fixture', method: 'tools/call' }), {
      code: 'MCP_INVALID_RESPONSE',
    });
  }
  for (const structuredContent of [null, [], 'answer', 42, true])
    assert.equal(
      validateMcpResultType(
        { resultType: 'complete', content: [], structuredContent },
        { protocolVersion: '2026-07-28', serverName: 'fixture', method: 'tools/call' },
      ).structuredContent,
      structuredContent,
    );
  assert.throws(
    () => validateMcpResultType({ resultType: 'complete' }, { protocolVersion: '2025-11-25', serverName: 'fixture', method: 'tools/call' }),
    { code: 'MCP_INVALID_RESPONSE' },
  );
});

test('MCP modern result metadata and schema URI fields validate against protocol shapes', () => {
  const options = { protocolVersion: '2026-07-28', serverName: 'fixture', method: 'tools/call' };
  const result = {
    resultType: 'complete',
    content: [],
    _meta: {
      'io.modelcontextprotocol/serverInfo': {
        name: 'fixture',
        version: '1.0.0',
        websiteUrl: 'https://example.test/',
        icons: [{ src: 'data:image/png;base64,AAAA' }],
      },
    },
  };
  assert.equal(validateMcpResultType(result, options), result);
  for (const serverInfo of ['fixture', { name: 'fixture' }, { name: 'fixture', version: '1.0.0', websiteUrl: '/relative' }]) {
    assert.throws(() => validateMcpResultType({ ...result, _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } }, options), {
      code: 'MCP_INVALID_RESPONSE',
    });
  }
  assert.throws(() => validateMcpResultType({ ...result, _meta: [] }, options), { code: 'MCP_INVALID_RESPONSE' });

  const legacy = { content: [], _meta: { 'io.modelcontextprotocol/serverInfo': 'legacy extension data' } };
  assert.equal(validateMcpResultType(legacy, { ...options, protocolVersion: '2025-11-25' }), legacy);
});

test('MCP list results validate tool, resource, template, and prompt definitions', () => {
  const options = { protocolVersion: '2026-07-28', serverName: 'fixture' };
  const cache = { resultType: 'complete', cacheScope: 'private', ttlMs: 10 };
  const validCases = [
    [
      'tools/list',
      {
        ...cache,
        tools: [
          {
            name: 'search',
            inputSchema: { type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema', properties: {} },
            outputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema' },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    ],
    [
      'resources/list',
      { ...cache, resources: [{ name: 'report', uri: 'file:///report.txt', size: 10, annotations: { audience: ['user'] } }] },
    ],
    [
      'resources/templates/list',
      {
        ...cache,
        resourceTemplates: [{ name: 'report', uriTemplate: 'file:///reports/{id}', icons: [{ src: 'https://example.test/icon.png' }] }],
      },
    ],
    ['prompts/list', { ...cache, prompts: [{ name: 'summarize', arguments: [{ name: 'text', required: true }] }] }],
  ];
  for (const [method, result] of validCases) assert.equal(validateMcpResultType(result, { ...options, method }), result);

  for (const [method, result] of [
    ['tools/list', { ...cache, tools: [{ name: 'bad', inputSchema: { type: 'array' } }] }],
    ['tools/list', { ...cache, tools: [{ name: 'bad', inputSchema: { type: 'object', $schema: 1 } }] }],
    ['tools/list', { ...cache, tools: [{ name: 'bad', inputSchema: { type: 'object' }, outputSchema: { $schema: 1 } }] }],
    ['resources/list', { ...cache, resources: [{ name: 'missing uri' }] }],
    ['resources/list', { ...cache, resources: [{ name: 'bad uri', uri: '/relative' }] }],
    ['resources/templates/list', { ...cache, resourceTemplates: [{ name: 'missing template' }] }],
    ['prompts/list', { ...cache, prompts: [{ name: 'bad', arguments: [{ name: 'x', required: 'yes' }] }] }],
  ])
    assert.throws(() => validateMcpResultType(result, { ...options, method }), { code: 'MCP_INVALID_RESPONSE' });
});

test('MCP discovery validates advertised capabilities and instructions', () => {
  const options = { protocolVersion: '2026-07-28', serverName: 'fixture', method: 'server/discover' };
  const valid = {
    resultType: 'complete',
    cacheScope: 'public',
    ttlMs: 0,
    supportedVersions: ['2026-07-28'],
    instructions: 'Read-only search tools',
    capabilities: {
      tools: { listChanged: true, vendorOption: 'extension field' },
      extensions: { 'io.example/cap': { enabled: true } },
    },
  };
  assert.equal(validateMcpResultType(valid, options), valid);
  for (const result of [
    { ...valid, capabilities: { tools: { listChanged: 'yes' } } },
    { ...valid, capabilities: { extensions: { 'io.example/cap': true } } },
    { ...valid, capabilities: { resources: { subscribe: 'yes' } } },
    { ...valid, instructions: 1 },
    { ...valid, _meta: [] },
  ])
    assert.throws(() => validateMcpResultType(result, options), { code: 'MCP_INVALID_RESPONSE' });
});

test('MCP modern resource and prompt results require result types while legacy results remain compatible', () => {
  for (const method of [
    'server/discover',
    'tools/list',
    'resources/list',
    'resources/templates/list',
    'resources/read',
    'prompts/list',
    'prompts/get',
  ]) {
    assert.throws(() => validateMcpResultType({}, { protocolVersion: '2026-07-28', serverName: 'fixture', method }), {
      code: 'MCP_INVALID_RESPONSE',
    });
    const result = {
      ...(method === 'server/discover' ? { supportedVersions: ['2026-07-28'], capabilities: {} } : {}),
      ...(method === 'tools/call' ? { content: [] } : {}),
      ...(method === 'tools/list' ? { tools: [] } : {}),
      ...(method === 'resources/list' ? { resources: [] } : {}),
      ...(method === 'resources/templates/list' ? { resourceTemplates: [] } : {}),
      ...(method === 'resources/read' ? { contents: [] } : {}),
      ...(method === 'prompts/list' ? { prompts: [] } : {}),
      ...(method === 'prompts/get' ? { messages: [] } : {}),
      resultType: 'complete',
      ...(['server/discover', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list'].includes(method)
        ? { cacheScope: 'private', ttlMs: 0 }
        : {}),
    };
    assert.equal(validateMcpResultType(result, { protocolVersion: '2026-07-28', method }), result);
    const { resultType: _resultType, ...legacy } = result;
    assert.equal(validateMcpResultType(legacy, { protocolVersion: '2025-11-25', method }), legacy);
  }
});

test('MCP resource reads and prompt messages validate returned content shapes', () => {
  const options = { protocolVersion: '2026-07-28', serverName: 'fixture' };
  assert.equal(
    validateMcpResultType(
      {
        resultType: 'complete',
        cacheScope: 'private',
        ttlMs: 0,
        contents: [{ uri: 'file:///workspace/a.txt', text: 'contents' }],
      },
      { ...options, method: 'resources/read' },
    ).contents[0].text,
    'contents',
  );
  assert.equal(
    validateMcpResultType(
      { resultType: 'complete', messages: [{ role: 'assistant', content: { type: 'text', text: 'answer' } }] },
      { ...options, method: 'prompts/get' },
    ).messages[0].role,
    'assistant',
  );
  for (const [method, result] of [
    [
      'resources/read',
      { resultType: 'complete', cacheScope: 'private', ttlMs: 0, contents: [{ uri: 'file:///workspace/a.txt', blob: 42 }] },
    ],
    [
      'resources/read',
      { resultType: 'complete', cacheScope: 'private', ttlMs: 0, contents: [{ uri: 'file:///workspace/a.txt', blob: 'not base64' }] },
    ],
    ['prompts/get', { resultType: 'complete', messages: [{ role: 'system', content: { type: 'text', text: 'ignored' } }] }],
    ['prompts/get', { resultType: 'complete', messages: [{ role: 'user', content: { type: 'text', text: 1 } }] }],
  ])
    assert.throws(() => validateMcpResultType(result, { ...options, method }), { code: 'MCP_INVALID_RESPONSE' });
});

test('MCP result type validation rejects unsupported control flow and unknown modern results', () => {
  for (const [resultType, code] of [
    ['input_required', 'MCP_INTERACTIVE_INPUT_UNSUPPORTED'],
    ['task', 'MCP_TASK_UNSUPPORTED'],
    ['future-control-flow', 'MCP_INVALID_RESPONSE'],
  ]) {
    assert.throws(
      () => validateMcpResultType({ resultType }, { protocolVersion: '2026-07-28', serverName: 'fixture', method: 'tools/call' }),
      { code },
    );
  }
});
