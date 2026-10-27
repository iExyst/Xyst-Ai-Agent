import assert from 'node:assert/strict';
import test from 'node:test';

const requestMessages = [{ role: 'user', content: 'Read a.txt and report what it contains.' }];

/**
 * Register the provider-independent behavior required by the shared runtime.
 * Provider-specific fixtures belong in createProvider, not in these assertions.
 */
export function registerProviderConformanceTests({ name, createProvider }) {
  test(`${name}: model listing returns unique, non-empty model IDs`, async () => {
    const provider = createProvider({ scenario: 'success' });
    const models = await provider.listModels();
    assert.ok(Array.isArray(models));
    assert.ok(models.length > 0);
    assert.ok(models.every((model) => typeof model.id === 'string' && model.id.trim().length > 0));
    assert.equal(new Set(models.map((model) => model.id)).size, models.length);
  });

  test(`${name}: chat returns normalized content, usage, and correlated tool calls`, async () => {
    const provider = createProvider({ scenario: 'success' });
    const response = await provider.chat(requestMessages, {
      tools: [
        {
          name: 'read_file',
          description: 'Read one file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
    });
    assert.equal(typeof response.content, 'string');
    assert.ok(Array.isArray(response.toolCalls));
    assert.ok(response.usage === null || typeof response.usage === 'object');
    assert.equal(response.content, 'The file contains a note.');
    assert.equal(response.toolCalls.length, 1);
    assert.equal(response.toolCalls[0].name, 'read_file');
    assert.deepEqual(JSON.parse(response.toolCalls[0].arguments), { path: 'a.txt' });
    assert.ok(response.toolCalls[0].id.length > 0);
    assert.equal(new Set(response.toolCalls.map((call) => call.id)).size, response.toolCalls.length);
  });

  test(`${name}: streaming ends with a final response equivalent to non-streaming chat`, async () => {
    const provider = createProvider({ scenario: 'success' });
    const events = [];
    for await (const event of provider.stream(requestMessages)) events.push(event);
    const finalEvents = events.filter((event) => event.type === 'done');
    assert.equal(finalEvents.length, 1);
    assert.equal(events.at(-1), finalEvents[0]);
    assert.ok(events.slice(0, -1).every((event) => event.type === 'text'));
    assert.equal(
      events
        .filter((event) => event.type === 'text')
        .map((event) => event.text)
        .join(''),
      finalEvents[0].response.content,
    );
    const chat = await provider.chat(requestMessages);
    assert.deepEqual(finalEvents[0].response, chat);
  });

  test(`${name}: caller cancellation is reported as CANCELLED`, async () => {
    const provider = createProvider({ scenario: 'cancel' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(provider.chat(requestMessages, { signal: controller.signal }), (error) => error.code === 'CANCELLED');
  });
}
