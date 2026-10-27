import assert from 'node:assert/strict';
import test from 'node:test';
import { createTts, resolveMacVoice } from '../src/tts/api.mjs';

test('Windows speech keeps user text out of the PowerShell command', async () => {
  const text = "hello'; Remove-Item -Recurse C:\\important; #";
  let call;
  const speak = createTts({
    platform: 'win32',
    runCommand: async (...args) => {
      call = args;
      return true;
    },
  });

  assert.equal(await speak(text, { lang: 'en-US' }), true);
  assert.equal(call[0], 'powershell.exe');
  assert.equal(call[1][3], '-Command');
  assert.ok(!call[1][4].includes(text));
  assert.equal(call[2].input, text);
  assert.deepEqual(call[2].env, { XYST_TTS_LANG: 'en-US' });
});

test('Linux speech falls back to Festival when Speech Dispatcher is unavailable', async () => {
  const calls = [];
  const results = [false, true];
  const speak = createTts({
    platform: 'linux',
    runCommand: async (...args) => {
      calls.push(args);
      return results.shift();
    },
  });

  assert.equal(await speak('hello from Linux'), true);
  assert.deepEqual(calls, [
    ['spd-say', ['--wait', '--', 'hello from Linux']],
    ['festival', ['--tts'], { input: 'hello from Linux' }],
  ]);
});

test('macOS speech maps a locale to an installed voice name and passes text separately', async () => {
  let call;
  let selectedLanguage;
  const speak = createTts({
    platform: 'darwin',
    findMacVoice: async (language) => {
      selectedLanguage = language;
      return 'Samantha';
    },
    runCommand: async (...args) => {
      call = args;
      return true;
    },
  });

  assert.equal(await speak('-hello', { lang: 'en-US' }), true);
  assert.equal(selectedLanguage, 'en-US');
  assert.deepEqual(call, ['say', ['-v', 'Samantha', '--', '-hello']]);
});

test('macOS voice selection prefers an exact locale then falls back to the language', () => {
  const voices = ['Samantha en_US # English', 'Daniel en_GB # English', 'Thomas fr_FR # French'].join('\n');
  assert.equal(resolveMacVoice(voices, 'en-GB'), 'Daniel');
  assert.equal(resolveMacVoice(voices, 'en-AU'), 'Samantha');
  assert.equal(resolveMacVoice(voices, 'ja-JP'), null);
});

test('macOS speech falls back to the system voice when the requested locale is not installed', async () => {
  let call;
  const speak = createTts({
    platform: 'darwin',
    findMacVoice: async () => null,
    runCommand: async (...args) => {
      call = args;
      return true;
    },
  });

  assert.equal(await speak('hello', { lang: 'en-US' }), true);
  assert.deepEqual(call, ['say', ['--', 'hello']]);
});

test('speech input and locale values are validated', async () => {
  const speak = createTts({ platform: 'linux', runCommand: async () => true });

  await assert.rejects(speak(42), { name: 'TypeError', message: 'Speech text must be a string' });
  await assert.rejects(speak('hello', { lang: 'en-US; Remove-Item *' }), {
    name: 'TypeError',
    message: 'Speech language must be a valid locale such as en-US',
  });
  assert.equal(await speak('  '), true);
});

test('unsupported platforms fail explicitly', async () => {
  const speak = createTts({ platform: 'freebsd', runCommand: async () => true });

  await assert.rejects(speak('hello'), { message: 'Text-to-speech is not supported on freebsd' });
});
