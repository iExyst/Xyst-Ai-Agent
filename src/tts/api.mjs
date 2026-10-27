import { spawn } from 'node:child_process';
import os from 'node:os';

const SPEECH_TIMEOUT_MS = 60_000;
const MACOS_VOICE_LIST_TIMEOUT_MS = 5_000;
const MACOS_VOICE_LIST_LIMIT_BYTES = 512 * 1024;
const WINDOWS_SPEECH_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$text = [Console]::In.ReadToEnd()',
  '$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'if ($env:XYST_TTS_LANG) { $voice = $synthesizer.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq $env:XYST_TTS_LANG } | Select-Object -First 1; if ($voice) { $synthesizer.SelectVoice($voice.VoiceInfo.Name) } }',
  '$synthesizer.Speak($text)',
].join('; ');

export function createTts({ platform = os.platform(), runCommand = runSpeechCommand, findMacVoice = findInstalledMacVoice } = {}) {
  if (typeof platform !== 'string' || !platform) throw new TypeError('A platform name is required');
  if (typeof runCommand !== 'function') throw new TypeError('A speech command runner is required');
  if (typeof findMacVoice !== 'function') throw new TypeError('A macOS voice resolver is required');

  return async function speak(text, options = {}) {
    if (typeof text !== 'string') throw new TypeError('Speech text must be a string');
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Speech options must be an object');
    if (!text.trim()) return true;

    const language = options.lang;
    if (language !== undefined && (typeof language !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)))
      throw new TypeError('Speech language must be a valid locale such as en-US');

    if (platform === 'win32') {
      return runCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SPEECH_SCRIPT], {
        input: text,
        ...(language ? { env: { XYST_TTS_LANG: language } } : {}),
      });
    }

    if (platform === 'darwin') {
      const voice = language ? await findMacVoice(language) : null;
      return runCommand('say', [...(voice ? ['-v', voice] : []), '--', text]);
    }

    if (platform === 'linux') {
      if (await runCommand('spd-say', ['--wait', '--', text])) return true;
      return runCommand('festival', ['--tts'], { input: text });
    }

    throw new Error(`Text-to-speech is not supported on ${platform}`);
  };
}

export const speak = createTts();

function findInstalledMacVoice(language) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    let output = '';
    const finish = (voice) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(voice);
    };

    try {
      child = spawn('say', ['-v', '?'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish(null);
      return;
    }

    child.stdout.on('data', (chunk) => {
      if (Buffer.byteLength(output) + chunk.length > MACOS_VOICE_LIST_LIMIT_BYTES) {
        child.kill();
        finish(null);
        return;
      }
      output += chunk.toString('utf8');
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code === 0 ? resolveMacVoice(output, language) : null));
    timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, MACOS_VOICE_LIST_TIMEOUT_MS);
    timer.unref?.();
  });
}

export function resolveMacVoice(output, language) {
  if (typeof output !== 'string' || typeof language !== 'string') return null;
  const normalizedLanguage = language.replaceAll('-', '_').toLowerCase();
  const languagePrefix = normalizedLanguage.split('_')[0];
  const voices = output
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(.*?)\s+([A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*)\s+#/))
    .filter(Boolean)
    .map(([, name, locale]) => ({ name: name.trim(), locale: locale.replaceAll('-', '_').toLowerCase() }))
    .filter((voice) => voice.name);
  return (
    voices.find((voice) => voice.locale === normalizedLanguage)?.name ||
    voices.find((voice) => voice.locale.split('_')[0] === languagePrefix)?.name ||
    null
  );
}

function runSpeechCommand(command, args, { input, env } = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    const finish = (success, warning) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (warning) console.warn(`TTS error: ${warning}`);
      resolve(success);
    };

    try {
      child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
    } catch (error) {
      finish(false, error instanceof Error ? error.message : String(error));
      return;
    }

    child.once('error', (error) => finish(false, error.message));
    child.once('close', (code) => finish(code === 0, code === 0 ? undefined : `${command} exited with status ${code}`));
    if (child.stdin) {
      child.stdin.once('error', (error) => finish(false, error.message));
      child.stdin.end(input ?? '');
    }

    timer = setTimeout(() => {
      child.kill();
      finish(false, `${command} timed out`);
    }, SPEECH_TIMEOUT_MS);
    timer.unref?.();
  });
}
