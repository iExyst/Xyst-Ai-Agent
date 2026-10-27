#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { speak } from './api.mjs';

export const TTS_CLI_USAGE = `Usage: pnpm speak [options] <text>

Options:
  --lang <locale>  Speech locale (default: en-US)
  --help, -h       Show this help
`;

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function parseTtsArguments(args) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) throw usageError('Arguments must be strings');

  let language = 'en-US';
  const words = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--') {
      words.push(...args.slice(index + 1));
      break;
    }
    if (argument === '--lang') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw usageError('Expected a locale after --lang');
      language = value;
      index += 1;
    } else if (argument.startsWith('--lang=')) {
      language = argument.slice('--lang='.length);
    } else if (argument.startsWith('--')) {
      throw usageError(`Unknown option: ${argument}`);
    } else {
      words.push(argument);
    }
  }

  if (!LOCALE_PATTERN.test(language)) throw usageError('Speech locale must look like en-US');
  const text = words.join(' ').trim();
  if (!text) throw usageError('Text to speak is required');
  return { help: false, language, text };
}

export async function runTtsCli(
  args = process.argv.slice(2),
  { speakImpl = speak, stdout = process.stdout, stderr = process.stderr } = {},
) {
  let options;
  try {
    options = parseTtsArguments(args);
  } catch (error) {
    stderr.write(`xyst-speak: ${error.message}\n${TTS_CLI_USAGE}`);
    return error.exitCode === 2 ? 2 : 1;
  }

  if (options.help) {
    stdout.write(TTS_CLI_USAGE);
    return 0;
  }

  try {
    const completed = await speakImpl(options.text, { lang: options.language });
    if (completed) return 0;
    stderr.write('xyst-speak: no speech engine could read the text.\n');
    return 1;
  } catch (error) {
    stderr.write(`xyst-speak: ${error instanceof Error ? error.message : 'Speech failed'}\n`);
    return 1;
  }
}

function usageError(message) {
  return Object.assign(new Error(message), { exitCode: 2 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runTtsCli();
