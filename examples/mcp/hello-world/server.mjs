import readline from 'node:readline';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_VERSION = '__PACKAGE_VERSION__';
const MAX_TEXT_LENGTH = 256;

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(null, -32700, 'Parse error');
    return;
  }

  if (!isRecord(request)) {
    fail(null, -32600, 'Invalid request');
    return;
  }

  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    if (Object.hasOwn(request, 'id')) fail(request.id, -32600, 'Invalid request');
    return;
  }

  if (!Object.hasOwn(request, 'id')) return;

  switch (request.method) {
    case 'server/discover':
      respond(request.id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'xyst-hello-world', version: SERVER_VERSION } },
      });
      break;
    case 'tools/list':
      respond(request.id, {
        tools: [
          {
            name: 'echo',
            description: 'Return the text supplied by the caller.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH } },
              required: ['text'],
              additionalProperties: false,
            },
          },
        ],
      });
      break;
    case 'tools/call': {
      const params = request.params;
      const text = params?.arguments?.text;
      if (
        !isRecord(params) ||
        params.name !== 'echo' ||
        typeof text !== 'string' ||
        text.length < 1 ||
        text.length > MAX_TEXT_LENGTH
      ) {
        fail(request.id, -32602, 'Expected echo with a non-empty text argument of at most 256 characters');
        break;
      }
      respond(request.id, { resultType: 'complete', content: [{ type: 'text', text: `echo: ${text}` }] });
      break;
    }
    case 'ping':
      respond(request.id, {});
      break;
    default:
      fail(request.id, -32601, 'Method not found');
  }
});
