import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { parseTtsArguments, runTtsCli, TTS_CLI_USAGE } from '../src/tts/tts-cli.mjs';

test('TTS CLI combines plain text arguments and accepts a locale option', () => {
  assert.deepEqual(parseTtsArguments(['--lang', 'fr-FR', 'hello', 'there']), {
    help: false,
    language: 'fr-FR',
    text: 'hello there',
  });
  assert.deepEqual(parseTtsArguments(['--lang=de-DE', 'Guten Tag']), {
    help: false,
    language: 'de-DE',
    text: 'Guten Tag',
  });
});

test('TTS CLI treats text after -- as speech text', () => {
  assert.deepEqual(parseTtsArguments(['--', '--hello', 'world']), {
    help: false,
    language: 'en-US',
    text: '--hello world',
  });
});

test('TTS CLI rejects missing text, missing locales, invalid locales, and unknown options', () => {
  for (const args of [[], ['--lang'], ['--lang', 'x;bad', 'hello'], ['--unknown', 'hello']]) assert.throws(() => parseTtsArguments(args));
});

test('TTS CLI help does not invoke the speech engine', async () => {
  let called = false;
  const stdout = captureStream();
  const stderr = captureStream();
  assert.equal(
    await runTtsCli(['--help'], {
      speakImpl: async () => {
        called = true;
      },
      stdout,
      stderr,
    }),
    0,
  );
  assert.equal(called, false);
  assert.equal(stdout.value, TTS_CLI_USAGE);
  assert.equal(stderr.value, '');
});

test('TTS CLI sends the parsed text and locale to the speech engine', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  let request;
  const exitCode = await runTtsCli(['--lang', 'en-GB', 'Hello', 'world'], {
    speakImpl: async (text, options) => {
      request = { text, options };
      return true;
    },
    stdout,
    stderr,
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(request, { text: 'Hello world', options: { lang: 'en-GB' } });
  assert.equal(stderr.value, '');
});

test('TTS CLI returns a failure when no speech engine is available or speech throws', async () => {
  const stderr = captureStream();
  assert.equal(await runTtsCli(['hello'], { speakImpl: async () => false, stderr }), 1);
  assert.match(stderr.value, /no speech engine/);

  const failure = captureStream();
  assert.equal(
    await runTtsCli(['hello'], {
      speakImpl: async () => {
        throw new Error('device unavailable');
      },
      stderr: failure,
    }),
    1,
  );
  assert.match(failure.value, /device unavailable/);
});

test('direct TTS CLI invocation displays help without starting speech', () => {
  const result = spawnSync(process.execPath, [path.resolve('src/tts/tts-cli.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: pnpm speak \[options\]/);
  assert.equal(result.stderr, '');
});

function captureStream() {
  let value = '';
  return {
    get value() {
      return value;
    },
    write(chunk) {
      value += String(chunk);
      return true;
    },
  };
}
