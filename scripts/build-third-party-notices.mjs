import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'licenses', 'THIRD-PARTY-NOTICES.md');
const MAX_NOTICE_BYTES = 20 * 1024 * 1024;

export async function buildThirdPartyNotices({ check = false } = {}) {
  const temporary = path.join(ROOT, 'licenses', `.THIRD-PARTY-NOTICES.${process.pid}.tmp`);
  const args = [
    'about',
    'generate',
    'licenses/third-party-notices.hbs',
    '--config',
    'licenses/about.toml',
    '--output-file',
    temporary,
    '--manifest-path',
    'gui/desktop/src-tauri/Cargo.toml',
    '--features',
    'sandbox-helper',
    '--fail',
    '--locked',
  ];
  const result = spawnSync('cargo', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new Error(`Could not run cargo-about: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0)
    throw new Error(`cargo about license generation failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);

  try {
    const info = await fs.lstat(temporary);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 512 || info.size > MAX_NOTICE_BYTES)
      throw new Error('Generated third-party license notice is missing or outside its size bounds');
    const rawGenerated = await fs.readFile(temporary);
    // Crate license files can contain CRLF even when generated on Linux.
    // Keep the committed inventory byte-for-byte stable across Windows and Linux.
    const generated = Buffer.from(rawGenerated.toString('utf8').replace(/\r\n?/g, '\n'));
    await fs.writeFile(temporary, generated);
    const text = generated.toString('utf8');
    if (!text.startsWith('THIRD-PARTY LICENSE NOTICES\n') || !text.includes('SPDX: '))
      throw new Error('Generated third-party notice is missing its title or license entries');
    if (check) {
      const committed = await fs.readFile(OUTPUT).catch((error) => {
        if (error.code === 'ENOENT') throw new Error('Committed third-party notices are missing; run pnpm licenses:desktop');
        throw error;
      });
      const normalizedCommitted = Buffer.from(committed.toString('utf8').replace(/\r\n?/g, '\n'));
      if (!normalizedCommitted.equals(generated))
        throw new Error('Third-party notices are stale; run pnpm licenses:desktop and review the updated file');
      return { path: OUTPUT, bytes: generated.length, changed: false };
    }
    await fs.rename(temporary, OUTPUT);
    return { path: OUTPUT, bytes: generated.length, changed: true };
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== '--check') || args.filter((argument) => argument === '--check').length > 1) {
    process.stderr.write('Usage: node scripts/build-third-party-notices.mjs [--check]\n');
    process.exitCode = 2;
  } else {
    buildThirdPartyNotices({ check: args.includes('--check') })
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        process.stderr.write(`${error.stack || error}\n`);
        process.exitCode = 1;
      });
  }
}
