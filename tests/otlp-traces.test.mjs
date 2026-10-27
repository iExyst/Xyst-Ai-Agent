import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySecretStore } from '../src/platform/secrets.mjs';
import { OtlpHttpTraceExporter } from '../src/observability/otlp-traces.mjs';

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const ENDPOINT = 'http://127.0.0.1:4318/v1/traces';

test('OTLP/HTTP JSON export creates correlated nested spans from sanitized lifecycle events', async () => {
  const requests = [];
  const secretStore = new InMemorySecretStore();
  await secretStore.set('telemetry.collector', 'collector-auth-canary');
  const exporter = new OtlpHttpTraceExporter({
    endpoint: ENDPOINT,
    headers: { Authorization: 'secret:telemetry.collector', 'x-scope': 'env:OTEL_SCOPE' },
    secretStore,
    env: { OTEL_SCOPE: 'xyst-test' },
    flushIntervalMs: 60_000,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({});
    },
  });

  exporter.record(record('api_run_started', 1, '2026-10-22T12:00:00.000Z'));
  exporter.record(record('run_started', 2, '2026-10-22T12:00:00.001Z'));
  exporter.record(
    record('tool_started', 3, '2026-10-22T12:00:00.010Z', {
      tool: 'write_file',
      prompt: 'OTLP_PROMPT_CANARY',
      path: 'C:\\private\\canary.txt',
      arguments: { content: 'OTLP_PAYLOAD_CANARY', api_key: 'OTLP_SECRET_CANARY' },
    }),
  );
  exporter.record(record('tool_finished', 4, '2026-10-22T12:00:00.052Z', { tool: 'write_file', status: 'completed' }));
  exporter.record(record('run_finished', 5, '2026-10-22T12:00:00.060Z', { status: 'completed' }));
  exporter.record(record('api_run_finished', 6, '2026-10-22T12:00:00.061Z', { status: 'completed' }));
  await exporter.close();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, ENDPOINT);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['content-type'], 'application/json');
  assert.equal(requests[0].options.headers.Authorization, 'collector-auth-canary');
  assert.equal(requests[0].options.headers['x-scope'], 'xyst-test');
  assert.equal(requests[0].options.redirect, 'error');
  const bodyText = requests[0].options.body;
  const body = JSON.parse(bodyText);
  assert.deepEqual(body.resourceSpans[0].resource.attributes, [{ key: 'service.name', value: { stringValue: 'xyst-agent' } }]);
  const spans = body.resourceSpans[0].scopeSpans[0].spans;
  assert.deepEqual(
    spans.map((span) => span.name),
    ['tool.execution', 'agent.run', 'api.run'],
  );
  const [toolSpan, runSpan, apiSpan] = spans;
  const traceId = CORRELATION_ID.replaceAll('-', '');
  assert.ok(spans.every((span) => span.traceId === traceId));
  assert.ok(spans.every((span) => span.flags === 1));
  assert.match(toolSpan.spanId, /^[0-9a-f]{16}$/);
  assert.match(runSpan.spanId, /^[0-9a-f]{16}$/);
  assert.equal(toolSpan.parentSpanId, runSpan.spanId);
  assert.equal(runSpan.parentSpanId, apiSpan.spanId);
  assert.equal(apiSpan.parentSpanId, undefined);
  assert.equal(toolSpan.startTimeUnixNano, '1792670400010000000');
  assert.equal(toolSpan.endTimeUnixNano, '1792670400052000000');
  assert.ok(toolSpan.attributes.some((attribute) => attribute.key === 'xyst.tool' && attribute.value.stringValue === 'write_file'));
  assert.doesNotMatch(
    bodyText,
    /OTLP_PROMPT_CANARY|OTLP_PAYLOAD_CANARY|OTLP_SECRET_CANARY|OTLP_SCOPE|collector-auth-canary|private|arguments/,
  );
  assert.equal(exporter.stats.exportedSpans, 3);
  assert.equal(exporter.stats.exportFailures, 0);
});

test('OTLP close exports unfinished spans as bounded incomplete spans', async () => {
  let payload;
  const exporter = new OtlpHttpTraceExporter({
    endpoint: ENDPOINT,
    flushIntervalMs: 60_000,
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return Response.json({});
    },
  });
  exporter.record(record('memory_context_started', 1, '2026-10-22T12:00:00.000Z'));
  await exporter.close();

  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, 'memory.context');
  assert.ok(span.attributes.some((attribute) => attribute.key === 'xyst.incomplete' && attribute.value.boolValue));
  assert.ok(span.attributes.some((attribute) => attribute.key === 'xyst.event.ended' && attribute.value.stringValue === 'incomplete'));
  assert.equal(exporter.stats.exportedSpans, 1);
});

test('OTLP marks failed subagent outcomes as span errors without exporting error text', async () => {
  let payload;
  const exporter = new OtlpHttpTraceExporter({
    endpoint: ENDPOINT,
    flushIntervalMs: 60_000,
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return Response.json({});
    },
  });
  exporter.record(record('subagent_task_started', 1, '2026-10-22T12:00:00.000Z'));
  exporter.record(record('subagent_task_finished', 2, '2026-10-22T12:00:00.100Z', { status: 'failed', error: 'PRIVATE_ERROR_CANARY' }));
  await exporter.close();

  const [span] = payload.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(span.status.code, 2);
  assert.ok(span.attributes.some((attribute) => attribute.key === 'xyst.status' && attribute.value.stringValue === 'failed'));
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_ERROR_CANARY/);
});

test('OTLP retries transient HTTP failures with backoff and sends the same bounded batch', async () => {
  const responses = [new Response(null, { status: 503 }), Response.json({})];
  const delays = [];
  const bodies = [];
  const exporter = new OtlpHttpTraceExporter({
    endpoint: ENDPOINT,
    flushIntervalMs: 60_000,
    random: () => 0,
    sleep: async (duration) => delays.push(duration),
    fetchImpl: async (_url, options) => {
      bodies.push(options.body);
      return responses.shift();
    },
  });
  exporter.record(record('approval_required', 1, '2026-10-22T12:00:00.000Z'));
  await exporter.flush();
  await exporter.close();

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(delays, [50]);
  assert.equal(exporter.stats.exportedSpans, 1);
  assert.equal(exporter.stats.exportFailures, 0);
});

test('OTLP does not retry permanent errors or partial-success responses', async () => {
  let permanentRequests = 0;
  const permanent = new OtlpHttpTraceExporter({
    endpoint: ENDPOINT,
    flushIntervalMs: 60_000,
    fetchImpl: async () => {
      permanentRequests += 1;
      return new Response(null, { status: 400 });
    },
  });
  permanent.record(record('approval_required', 1, '2026-10-22T12:00:00.000Z'));
  await permanent.close();
  assert.equal(permanentRequests, 1);
  assert.equal(permanent.stats.droppedSpans, 1);
  assert.equal(permanent.stats.exportFailures, 1);

  let partialRequests = 0;
  const partial = new OtlpHttpTraceExporter({
    endpoint: ENDPOINT,
    flushIntervalMs: 60_000,
    fetchImpl: async () => {
      partialRequests += 1;
      return Response.json({ partialSuccess: { rejectedSpans: '1', errorMessage: 'OTLP_PRIVATE_DIAGNOSTIC' } });
    },
  });
  partial.record(record('approval_required', 2, '2026-10-22T12:00:00.000Z'));
  await partial.close();
  assert.equal(partialRequests, 1);
  assert.equal(partial.stats.rejectedSpans, 1);
  assert.equal(partial.stats.exportedSpans, 0);
  assert.equal(partial.stats.exportFailures, 0);

  let warningRequests = 0;
  const warning = new OtlpHttpTraceExporter({
    endpoint: ENDPOINT,
    flushIntervalMs: 60_000,
    fetchImpl: async () => {
      warningRequests += 1;
      return Response.json({ partialSuccess: { rejectedSpans: '0', errorMessage: 'collector warning' } });
    },
  });
  warning.record(record('approval_required', 3, '2026-10-22T12:00:00.000Z'));
  await warning.close();
  assert.equal(warningRequests, 1);
  assert.equal(warning.stats.rejectedSpans, 0);
  assert.equal(warning.stats.exportedSpans, 1);
  assert.equal(warning.stats.exportFailures, 0);
});

test('OTLP bounds and validates collector responses without retrying malformed success payloads', async () => {
  const invalidResponses = [
    new Response('{malformed', { headers: { 'content-type': 'application/json' } }),
    new Response('[]', { headers: { 'content-type': 'application/json' } }),
    new Response('', { headers: { 'content-type': 'application/json' } }),
    new Response('{}'),
    new Response(' '.repeat(1_048_577), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'text/plain' } }),
    new Response('{"partialSuccess":null}', { headers: { 'content-type': 'application/json' } }),
  ];

  for (const response of invalidResponses) {
    let requests = 0;
    const exporter = new OtlpHttpTraceExporter({
      endpoint: ENDPOINT,
      flushIntervalMs: 60_000,
      fetchImpl: async () => {
        requests += 1;
        return response;
      },
    });
    exporter.record(record('approval_required', 1, '2026-10-22T12:00:00.000Z'));
    await exporter.close();
    assert.equal(requests, 1);
    assert.equal(exporter.stats.droppedSpans, 1);
    assert.equal(exporter.stats.exportFailures, 1);
  }
});

function record(event, sequence, timestamp, fields = {}) {
  return {
    schema_version: 1,
    timestamp,
    correlation_id: CORRELATION_ID,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    event,
    sequence,
    ...fields,
  };
}
