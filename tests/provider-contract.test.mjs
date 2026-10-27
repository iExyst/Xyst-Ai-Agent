import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.mjs';
import { registerProviderConformanceTests } from './helpers/provider-conformance.mjs';

function createFixtureProvider({ scenario }) {
  const model = {
    role: 'assistant',
    content: 'The file contains a note.',
    tool_calls: [{ id: 'call_read_file', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
  };
  const usage = { prompt_tokens: 11, completion_tokens: 8, total_tokens: 19 };
  const streamedFrames = [
    { choices: [{ delta: { content: 'The file ' } }] },
    {
      choices: [
        {
          delta: {
            content: 'contains a note.',
            tool_calls: [
              { index: 0, id: 'call_read_file', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage },
  ];

  return new OpenAICompatibleProvider({
    baseUrl: 'http://provider-contract.test/v1',
    model: 'contract-model',
    fetchImpl: async (url, options) => {
      if (scenario === 'cancel')
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          if (options.signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
        });
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'contract-model' }, { id: 'contract-model' }] });
      if (JSON.parse(options.body).stream) {
        const body = `${streamedFrames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({ choices: [{ message: model, finish_reason: 'tool_calls' }], usage });
    },
  });
}

registerProviderConformanceTests({
  name: 'OpenAI-compatible provider',
  createProvider: createFixtureProvider,
});
