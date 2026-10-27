import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.mjs';
import { createOpenAICompatibleProvider } from '../src/providers/factory.mjs';
import { calculateCost, classifyRoutingTask, estimateTokens, requiresToolsForTask, selectModel } from '../src/core/router.mjs';

test('image token estimates use dimensions and do not count base64 payload as text', () => {
  const image = {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(200_000)}` } }],
  };
  const placeholder = {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,[image data omitted from token estimate]' } }],
  };
  const dimensions = [{ width: 512, height: 512 }];
  assert.equal(estimateTokens([image], { imageAttachments: dimensions }), estimateTokens([placeholder], { imageAttachments: dimensions }));
  assert.equal(estimateTokens([image]), estimateTokens([placeholder]));
  assert.equal(estimateTokens([image]) - estimateTokens([placeholder], { imageAttachments: dimensions }), 0);
  const request = [{ role: 'user', content: 'small request' }];
  assert.equal(estimateTokens(request, { imageAttachments: [{ width: 1024, height: 768 }] }) - estimateTokens(request), 1_024);
});

test('prompt classifier favors configured quality or speed scores only when its signals are clear', () => {
  assert.deepEqual(classifyRoutingTask('Implement the feature, add tests, and verify behavior across multiple files.'), {
    intent: 'quality',
    quality_signals: 3,
    speed_signals: 0,
  });
  assert.deepEqual(classifyRoutingTask('Quickly define this option in one sentence.'), {
    intent: 'speed',
    quality_signals: 0,
    speed_signals: 3,
  });
  assert.deepEqual(classifyRoutingTask('Tell me about this setting.'), {
    intent: 'balanced',
    quality_signals: 0,
    speed_signals: 0,
  });
  assert.equal(classifyRoutingTask('There seems to be a problem with Xyst programming and working with the agent.').intent, 'quality');
  assert.equal(
    classifyRoutingTask(
      `Tell me about this setting. ${'neutral '.repeat(1200)}Implement this feature, add tests, and verify behavior. ${'neutral '.repeat(1200)}`,
    ).intent,
    'balanced',
    'classification ignores signals in the middle of oversized prompts',
  );
  assert.equal(
    classifyRoutingTask(`${'neutral '.repeat(1600)}Implement this feature, add tests, and verify behavior.`).intent,
    'quality',
    'classification includes a task directive at the end of a long prompt',
  );
});

test('tool routing is required for implementation requests but not ordinary programming questions', () => {
  assert.equal(requiresToolsForTask('agent', 'There is a problem with Xyst programming and working with the agent.'), true);
  assert.equal(requiresToolsForTask('agent', 'Look stuff up about the latest stable Node.js release.'), true);
  assert.equal(requiresToolsForTask('agent', 'Can you look stuf up about the current Xyst build?'), true);
  assert.equal(requiresToolsForTask('agent', 'Find information about current LM Studio releases.'), true);
  assert.equal(requiresToolsForTask('agent', 'What is the current price of gold?'), true);
  assert.equal(requiresToolsForTask('agent', 'What is programming?'), false);
  assert.equal(requiresToolsForTask('plan', 'Make a plan.'), true);
  assert.deepEqual(classifyRoutingTask('Make a TTS program.'), {
    intent: 'quality',
    quality_signals: 2,
    speed_signals: 0,
  });
});

test('quality routing balances coding strength with tool reliability for implementation tasks', () => {
  const selected = selectModel(
    {
      default_model: 'tool-specialist',
      routing: { selection: 'quality', prefer_local: false, classifier: { enabled: false } },
      models: {
        'tool-specialist': { supports_tools: true, coding_strength: 6, tool_calling_quality: 10, context_length: 16_000 },
        'strong-coder': { supports_tools: true, coding_strength: 10, tool_calling_quality: 8, context_length: 16_000 },
      },
    },
    { requireTools: true, taskType: 'agent' },
  );
  assert.equal(selected.name, 'strong-coder');
  const balanced = selectModel(
    {
      default_model: 'tool-specialist',
      routing: { selection: 'balanced', prefer_local: false, classifier: { enabled: false } },
      models: {
        'tool-specialist': { supports_tools: true, coding_strength: 6, tool_calling_quality: 10, context_length: 16_000 },
        'strong-coder': { supports_tools: true, coding_strength: 10, tool_calling_quality: 8, context_length: 16_000 },
      },
    },
    { requireTools: true, taskType: 'agent' },
  );
  assert.equal(balanced.name, 'strong-coder');
});

test('default prompt routing selects by intent while preserving explicit strategy, strict chain, and manual choices', () => {
  const config = {
    default_model: 'general',
    routing: { prefer_local: false },
    models: {
      general: { coding_strength: 6, speed_score: 6, local: true },
      strong: { coding_strength: 10, speed_score: 4, local: true },
      fast: { coding_strength: 4, speed_score: 10, local: true },
    },
  };

  const quality = selectModel(config, { taskPrompt: 'Implement this feature, add tests, and verify the migration.' });
  assert.equal(quality.name, 'strong');
  assert.equal(quality.factors.strategy, 'quality');
  assert.match(quality.reason, /prompt classifier favored quality/);
  assert.deepEqual(quality.factors.task_classification, {
    intent: 'quality',
    quality_signals: 2,
    speed_signals: 0,
    applied: true,
  });

  const speed = selectModel(config, { taskPrompt: 'Quickly define this setting in one sentence.' });
  assert.equal(speed.name, 'fast');
  assert.equal(speed.factors.strategy, 'speed');
  assert.match(speed.reason, /prompt classifier favored speed/);

  const neutral = selectModel(config, { taskPrompt: 'Tell me about this setting.' });
  assert.equal(neutral.name, 'general');
  assert.equal(neutral.factors.task_classification.applied, false);

  assert.equal(
    selectModel(config, { requestedModel: 'general', taskPrompt: 'Implement this feature and add tests.' }).name,
    'general',
    'explicit profile selection wins',
  );
  config.routing.selection = 'cost';
  const configuredStrategy = selectModel(config, { taskPrompt: 'Implement this feature, add tests, and verify the migration.' });
  assert.equal(configuredStrategy.factors.strategy, 'cost');
  assert.equal(configuredStrategy.factors.task_classification.applied, false);

  delete config.routing.selection;
  config.routing.fallback_chain = ['fast', 'strong'];
  config.models.general.context_length = 10;
  config.models.fast.context_length = 1000;
  config.models.strong.context_length = 1000;
  const strict = selectModel(config, {
    estimatedTokens: 100,
    taskPrompt: 'Implement this feature, add tests, and verify the migration.',
  });
  assert.equal(strict.name, 'fast');
  assert.equal(strict.factors.task_classification.applied, false);
});

test('automatic routing selects the stronger coding profile for an agent-programming problem report', () => {
  const config = {
    default_model: 'general',
    routing: { prefer_local: true },
    models: {
      general: { coding_strength: 5, tool_calling_quality: 5, speed_score: 9, supports_tools: true, local: true },
      coder: { coding_strength: 9, tool_calling_quality: 9, speed_score: 4, supports_tools: true, local: true },
    },
  };
  const prompt = 'There seems to be a problem with Xyst programming and working with the agent.';
  const choice = selectModel(config, { taskPrompt: prompt, requireTools: requiresToolsForTask('agent', prompt), taskType: 'agent' });
  assert.equal(choice.name, 'coder');
  assert.equal(choice.factors.strategy, 'quality');
  assert.equal(choice.factors.task_classification.applied, true);
});

test('prompt routing can be explicitly disabled', () => {
  const config = {
    default_model: 'general',
    routing: { classifier: { enabled: false } },
    models: { general: { coding_strength: 5 }, strong: { coding_strength: 10 } },
  };
  const choice = selectModel(config, { taskPrompt: 'Implement this and add tests.' });
  assert.equal(choice.name, 'general');
  assert.equal(Object.hasOwn(choice.factors, 'task_classification'), false);
});

test('automatic routing can be disabled while explicit pins and configured fallback order remain honored', () => {
  const config = {
    default_model: 'general',
    routing: { enabled: false, selection: 'quality', classifier: { enabled: true }, fallback_chain: ['strong'] },
    models: {
      general: { coding_strength: 5, supports_tools: false, context_length: 100 },
      strong: { coding_strength: 10, supports_tools: true, context_length: 1000 },
      other: { coding_strength: 9, supports_tools: true, context_length: 1000 },
    },
  };
  const fixed = selectModel(config, { taskPrompt: 'Implement this and add tests.' });
  assert.equal(fixed.name, 'general');
  assert.equal(fixed.factors.strategy, 'disabled');
  assert.equal(fixed.factors.automatic_routing_enabled, false);
  assert.equal(Object.hasOwn(fixed.factors, 'task_classification'), false);

  const requiredTools = selectModel(config, { requireTools: true });
  assert.equal(requiredTools.name, 'strong');
  assert.deepEqual(requiredTools.alternatives, [{ name: 'general', eligible: false, reason: 'required tool calling is disabled' }]);

  assert.equal(selectModel(config, { requestedModel: 'other' }).name, 'other');
  assert.throws(
    () => selectModel({ ...config, routing: { enabled: false }, default_model: 'general' }, { requireTools: true }),
    /Automatic routing is disabled/,
  );
});

test('provider sends auth, maps model list and normalizes chat response', async () => {
  const calls = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost:1234/v1/',
    model: 'local',
    apiKey: 'secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'local' }] });
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      });
    },
  });
  assert.deepEqual(await provider.listModels(), [{ id: 'local' }]);
  const response = await provider.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(response.content, 'hello');
  assert.deepEqual(response.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret');
  assert.equal(calls[1].url, 'http://localhost:1234/v1/chat/completions');
});

test('prompt cache controls are omitted by default and sent only after profile opt-in', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (JSON.parse(options.body).stream)
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  };
  const disabled = new OpenAICompatibleProvider({ baseUrl: 'http://localhost/v1', model: 'x', fetchImpl });
  await disabled.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(Object.hasOwn(calls[0], 'prompt_cache_key'), false);
  assert.equal(Object.hasOwn(calls[0], 'prompt_cache_retention'), false);

  const enabled = createOpenAICompatibleProvider(
    {
      base_url: 'http://localhost/v1',
      model: 'x',
      prompt_cache_enabled: true,
      prompt_cache_key: 'xyst-main',
      prompt_cache_retention: '24h',
    },
    { fetchImpl },
  );
  await enabled.chat([{ role: 'user', content: 'hi' }]);
  for await (const _event of enabled.stream([{ role: 'user', content: 'hi' }])) {
    // Consume the response to exercise the streaming request path.
  }
  assert.deepEqual(
    calls.slice(1).map(({ prompt_cache_key, prompt_cache_retention }) => [prompt_cache_key, prompt_cache_retention]),
    [
      ['xyst-main', '24h'],
      ['xyst-main', '24h'],
    ],
  );
});

test('reasoning effort is opt-in per profile and reaches chat and stream requests', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (JSON.parse(options.body).stream)
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  };
  const provider = createOpenAICompatibleProvider(
    { base_url: 'http://localhost/v1', model: 'qwen3.5-9b', reasoning_effort: 'none' },
    { fetchImpl },
  );
  await provider.chat([{ role: 'user', content: 'Reply READY.' }]);
  for await (const _event of provider.stream([{ role: 'user', content: 'Reply READY.' }])) {
    // Consume the stream to inspect the request sent by this path too.
  }
  assert.deepEqual(
    calls.map(({ reasoning_effort }) => reasoning_effort),
    ['none', 'none'],
  );
  const defaultProvider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost/v1', model: 'x', fetchImpl });
  await defaultProvider.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(Object.hasOwn(calls[2], 'reasoning_effort'), false);
});

test('provider rejects malformed assistant message and tool-call payload shapes', async () => {
  const responses = [
    { choices: [{ message: [] }] },
    { choices: [{ message: { content: 42 } }] },
    { choices: [{ message: { tool_calls: [null] } }] },
    { choices: [{ message: { tool_calls: [{ id: 'call-1' }] } }] },
    { choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: {} } }] } }] },
  ];
  for (const body of responses) {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      model: 'x',
      fetchImpl: async () => Response.json(body),
    });
    await assert.rejects(provider.chat([]), (error) => error.code === 'INVALID_RESPONSE');
  }
});

test('provider treats output-limited empty assistant completions as provider failures so model routing can fall back', async () => {
  const chatProvider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () =>
      Response.json({
        choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'private reasoning only' }, finish_reason: 'length' }],
      }),
  });
  await assert.rejects(chatProvider.chat([{ role: 'user', content: 'Reply READY.' }]), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.retryable, false);
    assert.match(error.message, /without returning assistant text or a tool call/);
    return true;
  });

  const streamEvent = {
    choices: [{ delta: {}, finish_reason: 'length' }],
  };
  const streamProvider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () =>
      new Response(`data: ${JSON.stringify(streamEvent)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
  await assert.rejects(
    async () => {
      for await (const _event of streamProvider.stream([{ role: 'user', content: 'Reply READY.' }])) {
        // The stream must not report completion without usable assistant output.
      }
    },
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === false,
  );
});

test('provider preserves valid tool-call IDs and normalizes missing, invalid, or duplicate IDs', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async (_url, options) => {
      if (JSON.parse(options.body).stream) {
        const event = {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'stream_id', function: { name: 'read_file', arguments: '{}' } },
                  { index: 1, id: 'stream_id', function: { name: 'list_dir', arguments: '{}' } },
                  { index: 2, function: { name: 'search', arguments: '{}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        };
        return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_keep', function: { name: 'read_file', arguments: '{}' } },
                { id: 'call_keep', function: { name: 'list_dir', arguments: '{}' } },
                { function: { name: 'search', arguments: '{}' } },
                { id: 'invalid\u001b', function: { name: 'write_file', arguments: '{}' } },
                { id: 'x'.repeat(257), function: { name: 'edit_file', arguments: '{}' } },
              ],
            },
          },
        ],
      });
    },
  });

  const chat = await provider.chat([{ role: 'user', content: 'Use tools.' }]);
  assert.deepEqual(
    chat.toolCalls.map(({ id }) => id),
    ['call_keep', 'xyst_call_1', 'xyst_call_2', 'xyst_call_3', 'xyst_call_4'],
  );
  assert.equal(new Set(chat.toolCalls.map(({ id }) => id)).size, chat.toolCalls.length);

  const streamEvents = [];
  for await (const event of provider.stream([{ role: 'user', content: 'Use tools.' }])) streamEvents.push(event);
  const streamedCalls = streamEvents.find((event) => event.type === 'done').response.toolCalls;
  assert.deepEqual(
    streamedCalls.map(({ id }) => id),
    ['stream_id', 'xyst_call_1', 'xyst_call_2'],
  );
  assert.equal(new Set(streamedCalls.map(({ id }) => id)).size, streamedCalls.length);
});

test('provider reports cached input tokens only when they are valid and within reported prompt tokens', async () => {
  const responses = [
    { prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 7 } },
    { prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 21 } },
    { prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: -1 } },
    { completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } },
  ];
  for (const usage of responses) {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      model: 'x',
      fetchImpl: async () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage }),
    });
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    if (usage.prompt_tokens_details.cached_tokens === 7) assert.equal(result.usage.cachedInputTokens, 7);
    else assert.equal('cachedInputTokens' in result.usage, false);
  }
});

test('provider translates private byte limits out of the JSON Schema sent to model APIs', async () => {
  let request;
  const tool = {
    name: 'write_text',
    description: 'Write text.',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', maxBytes: 4096 }, tags: { type: 'array', items: { type: 'string', maxBytes: 80 } } },
      required: ['content'],
      additionalProperties: false,
    },
    approval: 'ask',
    destructive: true,
    execution: { timeout: { kind: 'platform_operation' }, sandbox: 'not_applicable' },
  };
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    },
  });
  await provider.chat([{ role: 'user', content: 'Write.' }], { tools: [tool], toolChoice: 'none' });
  const parameters = request.tools[0].function.parameters;
  assert.equal(request.tool_choice, 'none');
  assert.deepEqual(parameters.properties.content, { type: 'string' });
  assert.deepEqual(parameters.properties.tags.items, { type: 'string' });
  assert.equal(tool.parameters.properties.content.maxBytes, 4096, 'runtime validation retains byte-accurate limits');
  assert.equal('execution' in request.tools[0], false);
});

test('provider sends structured response formats for chat and streaming requests', async () => {
  const requests = [];
  const responseFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'review',
      strict: true,
      schema: { type: 'object', properties: { findings: { type: 'array' } }, required: ['findings'] },
    },
  };
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (JSON.parse(options.body).stream) {
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ];
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return Response.json({ choices: [{ message: { role: 'assistant', content: '{"findings":[]}' } }] });
    },
  });
  await provider.chat([{ role: 'user', content: 'Review.' }], { responseFormat });
  for await (const _event of provider.stream([{ role: 'user', content: 'Review.' }], { responseFormat })) {
    // Consume the stream so the request completes.
  }
  assert.deepEqual(
    requests.map((request) => request.response_format),
    [responseFormat, responseFormat],
  );
});

test('model listing bounds response size and identifiers and reports provider truncation', async () => {
  const data = Array.from({ length: 505 }, (_, index) => ({
    id: `model-${index}`,
    object: 'model',
    created: index,
    owned_by: 'local',
    secret_metadata: 'ignored',
  }));
  data.push({ id: 'x'.repeat(257) }, null, { object: 'model' });
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () => Response.json({ data }),
  });
  const result = await provider.listModelsDetailed();
  assert.equal(result.models.length, 500);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.models[0], { id: 'model-0', object: 'model', created: 0, owned_by: 'local' });
  assert.deepEqual(await provider.listModels(), result.models);

  const oversized = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers({ 'content-length': String(1024 * 1024 + 1) }),
      body: null,
      text: async () => '{"data":[]}',
    }),
  });
  await assert.rejects(oversized.listModels(), (error) => error.code === 'INVALID_RESPONSE' && !error.message.includes('data'));
});

test('model listing drops blank and duplicate IDs and reports the sanitized result as truncated', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () => Response.json({ data: [{ id: 'model-a' }, { id: 'model-a' }, { id: '   ' }, { id: 'model-b' }] }),
  });
  const result = await provider.listModelsDetailed();
  assert.deepEqual(result.models, [{ id: 'model-a' }, { id: 'model-b' }]);
  assert.equal(result.truncated, true);
});

test('non-streaming provider responses are size bounded', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers({ 'content-length': String(8 * 1024 * 1024 + 1) }),
      body: null,
      text: async () => '{}',
    }),
  });
  await assert.rejects(provider.chat([]), (error) => error.code === 'INVALID_RESPONSE' && /size limit/.test(error.message));
});

test('non-streaming provider responses enforce the byte limit while reading chunked bodies', async () => {
  let cancelled = false;
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });

  await assert.rejects(provider.chat([]), (error) => error.code === 'INVALID_RESPONSE' && /size limit/.test(error.message));
  assert.equal(cancelled, true, 'the provider must cancel a response that exceeds the byte limit');
});

test('non-streaming provider responses reject malformed UTF-8 JSON', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () => new Response(Uint8Array.of(0x7b, 0xff, 0x7d), { headers: { 'content-type': 'application/json' } }),
  });

  await assert.rejects(
    provider.chat([]),
    (error) => error.code === 'INVALID_RESPONSE' && /not valid UTF-8 JSON/.test(error.cause?.message || ''),
  );
});

test('non-streaming provider responses fail closed when their body is not stream-readable', async () => {
  let textRead = false;
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      body: null,
      async text() {
        textRead = true;
        return JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'unbounded' } }] });
      },
    }),
  });

  await assert.rejects(provider.chat([]), (error) => error.code === 'INVALID_RESPONSE' && /body stream/.test(error.cause?.message || ''));
  assert.equal(textRead, false, 'the provider must not bypass the body limit through response.text()');
});

test('provider streams have an aggregate byte ceiling', async () => {
  let cancelled = false;
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await assert.rejects(
    async () => {
      for await (const _event of provider.stream([])) {
        /* consume until the cap rejects */
      }
    },
    (error) => error.code === 'INVALID_STREAM' && /16777216-byte limit/.test(error.message),
  );
  assert.equal(cancelled, true, 'the provider must cancel an oversized stream immediately');
});

test('provider maps authentication and rate-limit errors without exposing auth header', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    apiKey: 'do-not-print',
    fetchImpl: async () => new Response('rate limit', { status: 429 }),
  });
  await assert.rejects(
    provider.chat([]),
    (error) => error.code === 'RATE_LIMITED' && error.retryable && !error.message.includes('do-not-print'),
  );
});

test('provider classifies explicit context overflow and unavailable gateway responses', async () => {
  const contextProvider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'Maximum context length is 8192 tokens' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
  });
  await assert.rejects(contextProvider.chat([]), (error) => {
    assert.equal(error.code, 'CONTEXT_OVERFLOW');
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false);
    return true;
  });
  await assert.rejects(contextProvider.listModels(), (error) => error.code === 'BAD_REQUEST' && error.status === 400);

  const lmStudioContextProvider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () =>
      Response.json(
        { error: { message: 'Engine protocol predict stream returned an error: {"message":"Context size has been exceeded."}' } },
        { status: 400 },
      ),
  });
  await assert.rejects(lmStudioContextProvider.chat([]), (error) => error.code === 'CONTEXT_OVERFLOW');

  const lmStudioAvailableContextProvider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () =>
      Response.json(
        {
          error: {
            message:
              'Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (8816 tokens) exceeds the available context size (8192 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":8816,"n_ctx":8192}}',
          },
        },
        { status: 400 },
      ),
  });
  await assert.rejects(lmStudioAvailableContextProvider.chat([]), (error) => error.code === 'CONTEXT_OVERFLOW');

  const unavailableProvider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () => new Response('upstream unavailable', { status: 503 }),
  });
  await assert.rejects(unavailableProvider.chat([]), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    return true;
  });
});

test('provider marks only the supported transient server statuses retryable', async () => {
  for (const status of [500, 502, 503, 504]) {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      model: 'x',
      fetchImpl: async () => new Response('temporary upstream failure', { status }),
    });
    await assert.rejects(provider.chat([]), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.retryable, true);
      return true;
    });
  }

  for (const status of [501, 505]) {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      model: 'x',
      fetchImpl: async () => new Response('unsupported protocol', { status }),
    });
    await assert.rejects(provider.chat([]), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.retryable, false);
      return true;
    });
  }
});

test('provider parses and bounds Retry-After for transient responses', async () => {
  const retryAfterMs = async (value) => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      model: 'x',
      fetchImpl: async () => new Response('rate limited', { status: 429, headers: { 'retry-after': value } }),
    });
    let parsed;
    await assert.rejects(provider.chat([]), (error) => {
      parsed = error.retryAfterMs;
      return error.status === 429;
    });
    return parsed;
  };

  assert.equal(await retryAfterMs('2'), 2000);
  assert.equal(await retryAfterMs('3600'), 60_000, 'large server delays are capped');
  const futureDate = new Date(Date.now() + 30_000).toUTCString();
  const futureDelay = await retryAfterMs(futureDate);
  assert.ok(futureDelay >= 28_000 && futureDelay <= 30_000, `unexpected date-form delay ${futureDelay}`);
  assert.equal(await retryAfterMs(new Date(Date.now() - 1000).toUTCString()), 0, 'past dates do not cause negative delays');
  for (const invalid of ['-1', '1.5', 'not a date', 'Mon, 31 Feb 2026 10:00:00 GMT'])
    assert.equal(await retryAfterMs(invalid), null, `invalid header should be ignored: ${invalid}`);
});

test('provider distinguishes its request timeout from a connection failure', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    timeoutMs: 10,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  });

  await assert.rejects(
    () => keepEventLoopAlive(() => provider.chat([]), 10),
    (error) => error.code === 'REQUEST_TIMEOUT' && error.retryable && /timed out/.test(error.message),
  );
});

test('chat requests can use a shorter per-call timeout than their profile default', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    timeoutMs: 10_000,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  });

  await assert.rejects(
    () => keepEventLoopAlive(() => provider.chat([], { timeoutMs: 10 }), 10),
    (error) => error.code === 'REQUEST_TIMEOUT' && error.retryable && /timed out/.test(error.message),
  );
});

test('provider maps timeouts while reading JSON and SSE bodies', async () => {
  const timedBody = (signal) =>
    new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });

  const jsonProvider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    timeoutMs: 30,
    fetchImpl: async (_url, { signal }) => new Response(timedBody(signal), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    () => keepEventLoopAlive(() => jsonProvider.chat([]), 30),
    (error) => error.code === 'REQUEST_TIMEOUT' && /timed out/.test(error.message),
  );

  const streamProvider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    timeoutMs: 30,
    fetchImpl: async (_url, { signal }) => new Response(timedBody(signal), { headers: { 'content-type': 'text/event-stream' } }),
  });
  await assert.rejects(
    () =>
      keepEventLoopAlive(async () => {
        for await (const _event of streamProvider.stream([])) {
          /* consume until the request timeout */
        }
      }, 30),
    (error) => error.code === 'REQUEST_TIMEOUT' && error.retryable && /timed out/.test(error.message),
  );
});

async function keepEventLoopAlive(run, timeoutMs) {
  const keepAlive = setTimeout(() => {}, timeoutMs + 250);
  try {
    return await run();
  } finally {
    clearTimeout(keepAlive);
  }
}

test('provider reads only a bounded prefix of an HTTP error response', async () => {
  let cancelled = false;
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('x'.repeat(1024 * 1024)));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 429 },
      ),
  });

  await assert.rejects(provider.chat([]), (error) => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.retryable, true);
    assert.equal(error.message, `Provider returned HTTP 429: ${'x'.repeat(500)}`);
    return true;
  });
  assert.equal(cancelled, true, 'the provider should cancel the response after reading the bounded prefix');
});

test('cost estimates stay unknown when price metadata is missing', () => {
  assert.equal(calculateCost({}, { inputTokens: 100, outputTokens: 50 }), null);
  assert.equal(calculateCost({ input_cost_per_million: 2, output_cost_per_million: 4 }, { inputTokens: 100, outputTokens: 50 }), 0.0004);
  const cachedRates = { input_cost_per_million: 2, cached_input_cost_per_million: 0.5, output_cost_per_million: 4 };
  assert.equal(calculateCost(cachedRates, { inputTokens: 100, outputTokens: 50, cachedInputTokens: 40 }), 0.00034);
  assert.equal(calculateCost(cachedRates, { inputTokens: 100, outputTokens: 50 }), 0.0004);
  assert.equal(calculateCost(cachedRates, { inputTokens: 100, outputTokens: 50, cachedInputTokens: 101 }), 0.0004);
});

test('model routing applies configured defaults, capability filters, and deterministic fallback strategies', () => {
  const config = {
    default_model: 'too-small',
    budgets: { max_output_tokens: 1000 },
    routing: { prefer_local: false, selection: 'cost' },
    models: {
      'too-small': { context_length: 100, supports_tools: true },
      expensive: { context_length: 10000, supports_tools: true, input_cost_per_million: 10, output_cost_per_million: 20 },
      cheap: { context_length: 10000, supports_tools: true, input_cost_per_million: 1, output_cost_per_million: 2 },
      vision: { context_length: 10000, supports_tools: true, supports_vision: true, input_cost_per_million: 2, output_cost_per_million: 4 },
      'no-tools': { context_length: 10000, supports_tools: false, input_cost_per_million: 0, output_cost_per_million: 0 },
    },
  };
  const selected = selectModel(config, { estimatedTokens: 500, requireTools: true });
  assert.equal(selected.name, 'cheap');
  assert.equal(selected.factors.pricing_data_status, 'unreviewed');
  assert.equal(selected.factors.capability_data_status, 'unreviewed');
  assert.equal(selected.reason, 'lowest estimated cost among capable models');
  const reviewedModelConfig = {
    ...config,
    models: { ...config.models, cheap: { ...config.models.cheap, pricing_updated_at: new Date().toISOString().slice(0, 10) } },
  };
  assert.equal(selectModel(reviewedModelConfig, { estimatedTokens: 500, requireTools: true }).factors.pricing_data_status, 'current');
  const staleModelConfig = {
    ...config,
    models: { ...config.models, cheap: { ...config.models.cheap, pricing_updated_at: '2000-01-01' } },
  };
  assert.equal(selectModel(staleModelConfig, { estimatedTokens: 500, requireTools: true }).factors.pricing_data_status, 'stale');
  const reviewedCapabilitiesConfig = {
    ...config,
    models: {
      ...config.models,
      cheap: { ...config.models.cheap, capabilities_updated_at: new Date().toISOString().slice(0, 10) },
    },
  };
  assert.equal(
    selectModel(reviewedCapabilitiesConfig, { estimatedTokens: 500, requireTools: true }).factors.capability_data_status,
    'current',
  );
  const staleCapabilitiesConfig = {
    ...config,
    models: { ...config.models, cheap: { ...config.models.cheap, capabilities_updated_at: '2000-01-01' } },
  };
  assert.equal(selectModel(staleCapabilitiesConfig, { estimatedTokens: 500, requireTools: true }).factors.capability_data_status, 'stale');
  assert.equal(
    selectModel(config, { estimatedTokens: 500 }).name,
    'cheap',
    'tool-capable candidates stay ahead of cheaper text-only profiles',
  );
  assert.equal(selectModel(config, { requestedModel: 'expensive', estimatedTokens: 500 }).name, 'expensive');
  assert.throws(() => selectModel(config, { requestedModel: 'too-small', estimatedTokens: 500 }), /insufficient context/);
  assert.throws(
    () => selectModel(config, { requestedModel: 'no-tools', estimatedTokens: 500, requireTools: true }),
    /does not support required tool use/,
  );
  assert.equal(selectModel(config, { estimatedTokens: 500, requireVision: true }).name, 'vision');
  assert.throws(() => selectModel(config, { requestedModel: 'cheap', estimatedTokens: 500, requireVision: true }), /image input/);

  config.routing.selection = 'quality';
  config.models.expensive.coding_strength = 9;
  config.models.cheap.coding_strength = 6;
  assert.equal(selectModel(config, { estimatedTokens: 500 }).name, 'expensive');
  config.routing.selection = 'speed';
  config.models.expensive.speed_score = 4;
  config.models.cheap.speed_score = 9;
  assert.equal(selectModel(config, { estimatedTokens: 500 }).name, 'cheap');
});

test('balanced review routing prefers the strongest configured coding and tool profile unless explicitly pinned', () => {
  const config = {
    default_model: 'general',
    routing: { selection: 'balanced', prefer_local: true },
    models: {
      general: {
        local: true,
        supports_tools: true,
        context_length: 32_000,
        coding_strength: 6,
        tool_calling_quality: 6,
      },
      reviewer: {
        local: true,
        supports_tools: true,
        context_length: 64_000,
        coding_strength: 9,
        tool_calling_quality: 9,
      },
      'text-only': {
        local: true,
        supports_tools: false,
        context_length: 128_000,
        coding_strength: 10,
        tool_calling_quality: 10,
      },
    },
  };

  const automatic = selectModel(config, { estimatedTokens: 4_000, requireTools: true, taskType: 'review' });
  assert.equal(automatic.name, 'reviewer');
  assert.equal(automatic.reason, 'highest configured coding and tool quality for review');
  assert.deepEqual(automatic.alternatives, [
    { name: 'general', eligible: true },
    { name: 'text-only', eligible: false, reason: 'required tool calling is disabled' },
  ]);

  const pinned = selectModel(config, { requestedModel: 'general', estimatedTokens: 4_000, requireTools: true, taskType: 'review' });
  assert.equal(pinned.name, 'general');
  assert.equal(pinned.reason, 'explicit user override');
});

test('model routing follows an explicit strict fallback chain and explains rejected profiles', () => {
  const config = {
    default_model: 'small',
    routing: { fallback_chain: ['strong-local', 'remote'] },
    models: {
      small: { context_length: 128, supports_tools: true },
      'strong-local': { context_length: 4096, supports_tools: false, local: true },
      remote: { context_length: 8192, supports_tools: true, local: false },
      unlisted: { context_length: 32000, supports_tools: true, local: true },
    },
  };
  const choice = selectModel(config, { estimatedTokens: 1000, requireTools: true });
  assert.equal(choice.name, 'remote');
  assert.equal(choice.reason, 'configured fallback 3 after small');
  assert.deepEqual(choice.factors, {
    required_context_tokens: 1000,
    required_tools: true,
    required_vision: false,
    automatic_routing_enabled: true,
    prefer_local: true,
    strategy: 'balanced',
    configured_default: 'small',
    pricing_data_status: 'unknown',
    capability_data_status: 'unreviewed',
  });
  assert.deepEqual(choice.alternatives, [
    { name: 'small', eligible: false, reason: 'context 128 is below required 1000 tokens' },
    { name: 'strong-local', eligible: false, reason: 'required tool calling is disabled' },
  ]);
  assert.throws(() => selectModel(config, { requestedModel: 'small', estimatedTokens: 1000 }), /insufficient context/);
  assert.throws(
    () => selectModel(config, { estimatedTokens: 1000, requireVision: true }),
    /image input.*vision capability is not enabled/s,
  );
});

test('provider rejects URLs with embedded credentials and query strings', () => {
  assert.throws(
    () => new OpenAICompatibleProvider({ baseUrl: 'https://user:secret@example.test/v1', model: 'x' }),
    /cannot contain credentials/,
  );
  assert.throws(() => new OpenAICompatibleProvider({ baseUrl: 'https://example.test/v1?key=secret', model: 'x' }), /query parameters/);
});

test('SSE parser handles arbitrary chunk boundaries and fragmented tool arguments', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hel',
    'lo"}}]}\r\n\r\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\\"a.txt\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":8}}}\n\n',
    'data: [DONE]\n\n',
  ];
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
      ),
  });
  const events = [];
  for await (const event of provider.stream([{ role: 'user', content: 'read' }])) events.push(event);
  assert.equal(
    events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join(''),
    'hello',
  );
  const done = events.find((event) => event.type === 'done');
  assert.equal(done.response.usage.cachedInputTokens, 8);
  assert.equal(done.response.toolCalls[0].name, 'read_file');
  assert.deepEqual(JSON.parse(done.response.toolCalls[0].arguments), { path: 'a.txt' });
});

test('SSE parser joins multiline data fields and ignores non-data fields', async () => {
  const body = [
    ': keep-alive',
    'event: message',
    'id: response-1',
    'data: {"choices":[',
    'data: {"delta":{"content":"joined"}},',
    'data: {"delta":{},"finish_reason":"stop"}',
    'data: ]}',
    '',
    'data: [DONE]',
    '',
  ].join('\r\n');
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const events = [];
  for await (const event of provider.stream([])) events.push(event);
  assert.deepEqual(
    events.filter((event) => event.type === 'text').map((event) => event.text),
    ['joined'],
  );
  assert.equal(events.find((event) => event.type === 'done').response.finishReason, 'stop');
});

test('SSE parser preserves data whitespace after removing only the optional single space', async () => {
  const body = ['data:  [DONE]', ''].join('\n');
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  });
  await assert.rejects(
    async () => {
      for await (const _event of provider.stream([])) {
        /* consume the stream */
      }
    },
    (error) => error.code === 'INVALID_STREAM' && /Malformed (?:final )?JSON/.test(error.message),
  );
});

test('SSE parser handles UTF-8, frame delimiters, and tool fragments split at every byte', async () => {
  const encoder = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'one-byte 🌟 chunks' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'byte-call', function: { name: 'read_file', arguments: '{"path":' } }] } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"notes.txt"}' } }] } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 4 } })}`,
    'data: [DONE]',
  ];
  const bytes = encoder.encode(`${frames.join('\r\n\r\n')}\r\n\r\n`);
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 1) controller.enqueue(bytes.subarray(offset, offset + 1));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const events = [];
  for await (const event of provider.stream([{ role: 'user', content: 'Read notes.txt.' }])) events.push(event);
  assert.equal(
    events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join(''),
    'one-byte 🌟 chunks',
  );
  const done = events.find((event) => event.type === 'done');
  assert.equal(done.response.usage.inputTokens, 7);
  assert.equal(done.response.usage.outputTokens, 4);
  assert.equal(done.response.toolCalls[0].id, 'byte-call');
  assert.equal(done.response.toolCalls[0].name, 'read_file');
  assert.deepEqual(JSON.parse(done.response.toolCalls[0].arguments), { path: 'notes.txt' });
});

test('SSE parser recognizes a CRLF frame delimiter split across transport chunks', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'split-boundary' } }] })}\r`,
    '\n\r',
    `\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\r\n\r\ndata: [DONE]\r`,
    '\n\r',
    '\n',
  ];
  let sourceClosed = false;
  let closeTimer;
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            closeTimer = setTimeout(() => {
              sourceClosed = true;
              controller.close();
            }, 250);
          },
          cancel() {
            clearTimeout(closeTimer);
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const events = [];
  for await (const event of provider.stream([])) events.push(event);
  assert.equal(sourceClosed, false, 'the provider should stop at [DONE] without waiting for the transport to close');
  assert.equal(events.find((event) => event.type === 'done').response.content, 'split-boundary');
});

test('provider rejects a successful but empty event stream instead of returning an empty assistant response', async () => {
  for (const body of ['', ': keep-alive\n\n', 'data: [DONE]\n\n']) {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      model: 'x',
      fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    });
    await assert.rejects(
      async () => {
        for await (const _event of provider.stream([])) {
          /* consume the stream */
        }
      },
      (error) => error.code === 'INVALID_STREAM' && /before any response events/.test(error.message),
    );
  }
});

test('provider rejects malformed streamed choices and tool-call fragments before accepting DONE', async () => {
  const events = [
    { choices: [null] },
    { choices: [{ delta: 42 }] },
    { choices: [{ delta: { content: 42 } }] },
    { choices: [{ delta: { tool_calls: {} } }] },
    { choices: [{ delta: { tool_calls: [{ index: '0', function: { name: 'read_file' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: {} } }] } }] },
    { choices: [{ delta: {}, finish_reason: 7 }] },
  ];
  for (const event of events) {
    const body = `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      model: 'x',
      fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    });
    await assert.rejects(
      async () => {
        for await (const _event of provider.stream([])) {
          /* consume the stream */
        }
      },
      (error) => error.code === 'INVALID_STREAM',
    );
  }
});

test('provider rejects a clean transport close before the model finish event', async () => {
  const partialFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'incomplete' } }] })}\n\n`;
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () => new Response(partialFrame, { headers: { 'content-type': 'text/event-stream' } }),
  });
  await assert.rejects(
    async () => {
      for await (const _event of provider.stream([])) {
        /* consume the incomplete stream */
      }
    },
    (error) => error.code === 'INVALID_STREAM' && /ended before a finish event/.test(error.message),
  );
});

test('provider accepts DONE as the terminal marker when finish_reason is omitted', async () => {
  const body = [`data: ${JSON.stringify({ choices: [{ delta: { content: 'incomplete' } }] })}`, 'data: [DONE]'].join('\n\n');
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const events = [];
  for await (const event of provider.stream([])) events.push(event);
  const response = events.find((event) => event.type === 'done').response;
  assert.equal(response.content, 'incomplete');
  assert.equal(response.finishReason, 'stop');
});

test('provider accepts a clean close after the model finish event without a DONE sentinel', async () => {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'complete' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
  ].join('\n\n');
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const events = [];
  for await (const event of provider.stream([])) events.push(event);
  assert.equal(events.find((event) => event.type === 'done').response.content, 'complete');
  assert.equal(events.find((event) => event.type === 'done').response.finishReason, 'stop');
});

test('provider maps a mid-stream abort to cancellation after yielding partial text', async () => {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`;
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://localhost/v1',
    model: 'x',
    fetchImpl: async (_url, options) =>
      new Response(
        new ReadableStream({
          start(streamController) {
            streamController.enqueue(encoder.encode(frame));
            options.signal.addEventListener('abort', () => streamController.error(new Error('transport aborted')), { once: true });
          },
          pull() {
            return new Promise(() => {});
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const iterator = provider.stream([], { signal: controller.signal });
  assert.deepEqual(await iterator.next(), { value: { type: 'text', text: 'partial' }, done: false });
  controller.abort();
  await assert.rejects(iterator.next(), (error) => error.code === 'CANCELLED');
});

test('provider stream error events fail without exposing provider-supplied error text', async () => {
  for (const event of [{ error: { message: 'private provider detail' } }, null, { choices: [] }]) {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      model: 'x',
      fetchImpl: async () =>
        new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    });
    await assert.rejects(
      async () => {
        for await (const _event of provider.stream([])) {
          /* consume the stream */
        }
      },
      (error) => {
        assert.ok(['INVALID_STREAM', 'STREAM_FAILED'].includes(error.code));
        assert.doesNotMatch(error.message, /private provider detail/);
        return true;
      },
    );
  }
});
