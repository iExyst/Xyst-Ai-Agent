import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER_NAME = 'xyst-sandbox-helper.exe';
const execFile = promisify(execFileCallback);

export async function packageWindowsSandboxHelper({ platform = process.platform } = {}) {
  if (platform !== 'win32') return { packaged: false, reason: 'Windows helper is only built on Windows' };
  await execFile(
    'cargo',
    [
      'build',
      '--locked',
      '--release',
      '--manifest-path',
      path.join(ROOT, 'gui', 'desktop', 'src-tauri', 'Cargo.toml'),
      '--bin',
      'xyst-sandbox-helper',
      '--features',
      'sandbox-helper',
    ],
    { cwd: ROOT, windowsHide: true, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 },
  );
  const manifestDirectory = path.join(ROOT, 'gui', 'desktop', 'src-tauri');
  const targetDirectory = process.env.CARGO_TARGET_DIR
    ? path.resolve(ROOT, process.env.CARGO_TARGET_DIR)
    : path.join(manifestDirectory, 'target');
  const source = path.join(targetDirectory, 'release', HELPER_NAME);
  const destination = path.join(ROOT, 'dist', 'desktop-runtime', 'native', `windows-${process.arch}`, HELPER_NAME);
  const sourceInfo = await fs.lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('Windows sandbox helper build output is not a regular file');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  return { packaged: true, path: destination, bytes: (await fs.stat(destination)).size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageWindowsSandboxHelper()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`package sandbox helper: ${error.message}\n`);
      process.exitCode = 1;
    });
}
