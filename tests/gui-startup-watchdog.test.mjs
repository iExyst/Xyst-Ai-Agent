import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const watchdogScript = await fs.readFile(new URL('../gui/startup-watchdog.mjs', import.meta.url), 'utf8');

function createWatchdogHarness() {
  const listeners = new Map();
  const scheduled = [];
  const indicator = {
    className: 'connection-dot',
    title: 'Connecting',
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
  const workspaceStatus = { textContent: 'Local · connecting' };
  const banner = { textContent: '', hidden: true };
  const document = {
    readyState: 'loading',
    documentElement: { dataset: {} },
    getElementById(id) {
      return {
        'connection-indicator': indicator,
        'workspace-status': workspaceStatus,
        'status-banner': banner,
      }[id];
    },
    addEventListener(name, callback) {
      const callbacks = listeners.get(`document:${name}`) ?? [];
      callbacks.push(callback);
      listeners.set(`document:${name}`, callbacks);
    },
  };
  const window = {
    addEventListener(name, callback) {
      const callbacks = listeners.get(`window:${name}`) ?? [];
      callbacks.push(callback);
      listeners.set(`window:${name}`, callbacks);
    },
  };

  vm.runInNewContext(watchdogScript, {
    document,
    window,
    setTimeout(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
  });

  return {
    document,
    indicator,
    listeners,
    scheduled,
    workspaceStatus,
    banner,
  };
}

function finishDocumentLoad(harness) {
  harness.document.readyState = 'interactive';
  for (const callback of harness.listeners.get('document:DOMContentLoaded') ?? []) callback();
}

test('startup watchdog reports a bounded runtime-unavailable message after 15 seconds', () => {
  const harness = createWatchdogHarness();

  finishDocumentLoad(harness);
  assert.equal(harness.scheduled.length, 1);
  assert.equal(harness.scheduled[0].delay, 15_000);
  harness.scheduled[0].callback();

  assert.equal(harness.document.documentElement.dataset.xystStartupReported, 'true');
  assert.equal(harness.indicator.className, 'connection-dot error');
  assert.equal(harness.indicator.title, 'Runtime unavailable');
  assert.equal(harness.indicator.attributes['aria-label'], 'Runtime unavailable');
  assert.equal(harness.workspaceStatus.textContent, 'Local · unavailable');
  assert.equal(harness.banner.hidden, false);
  assert.match(harness.banner.textContent, /did not connect.*15 seconds/i);
});

test('startup watchdog reports a generic script failure after the document becomes ready', () => {
  const harness = createWatchdogHarness();

  harness.listeners.get('window:error')[0]();
  finishDocumentLoad(harness);

  assert.equal(harness.document.documentElement.dataset.xystStartupReported, 'true');
  assert.equal(harness.banner.hidden, false);
  assert.match(harness.banner.textContent, /interface did not finish loading/i);
  assert.doesNotMatch(harness.banner.textContent, /stack|exception|undefined/i);
});

test('startup watchdog preserves a bounded script error detail to make interface failures diagnosable', () => {
  const harness = createWatchdogHarness();

  harness.listeners.get('window:error')[0]({ message: `Failed to load module ${'x'.repeat(500)}` });
  finishDocumentLoad(harness);

  assert.match(harness.banner.textContent, /Details: Failed to load module/);
  assert.ok(harness.banner.textContent.length < 400);
});

test('startup watchdog identifies a failed script resource when the browser omits its error message', () => {
  const harness = createWatchdogHarness();

  harness.listeners.get('window:error')[0]({ target: { src: 'http://127.0.0.1:1234/app/app.mjs' } });
  finishDocumentLoad(harness);

  assert.match(harness.banner.textContent, /Details: http:\/\/127\.0\.0\.1:1234\/app\/app\.mjs/);
});

test('startup watchdog shows an uncaught JavaScript exception from an error event', () => {
  const harness = createWatchdogHarness();

  harness.listeners.get('window:error')[0]({ error: new Error('Cannot read properties of undefined') });
  finishDocumentLoad(harness);

  assert.match(harness.banner.textContent, /Details: Cannot read properties of undefined/);
});

test('startup watchdog does not replace a startup result already reported by the app', () => {
  const harness = createWatchdogHarness();
  harness.document.documentElement.dataset.xystStartupReported = 'true';

  finishDocumentLoad(harness);

  assert.equal(harness.scheduled.length, 0);
  assert.equal(harness.banner.hidden, true);
  assert.equal(harness.indicator.title, 'Connecting');
});
