import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { waitForBubblewrapStart } from '../src/platform/bubblewrap-status.mjs';

test('Bubblewrap startup accepts a child PID split across status chunks', async () => {
  const child = fakeChild();
  const started = waitForBubblewrapStart(child);
  child.stdio[3].write('{"child-');
  child.stdio[3].write('pid":42}\n');
  assert.equal(await started, true);
  child.emit('close');
  child.stdio[3].end();
});

test('Bubblewrap startup rejects malformed or error-only status output', async () => {
  const child = fakeChild();
  const started = waitForBubblewrapStart(child);
  child.stdio[3].end('{"error":"namespace setup failed"}\nnot-json\n');
  child.emit('close');
  assert.equal(await started, false);
});

test('Bubblewrap startup fails closed when status is missing or times out', async () => {
  const withoutDescriptor = new EventEmitter();
  assert.equal(await waitForBubblewrapStart(withoutDescriptor, 10), false);

  const child = fakeChild();
  assert.equal(await waitForBubblewrapStart(child, 10), false);
  child.emit('close');
  child.stdio[3].end();
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdio = [];
  child.stdio[3] = new PassThrough();
  return child;
}
