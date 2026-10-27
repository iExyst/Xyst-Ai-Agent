import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconDirectory = path.join(root, 'gui', 'desktop', 'src-tauri', 'icons');
const sourceIcon = path.join(root, 'gui', 'assets', 'brand-icon.png');
const require = createRequire(import.meta.url);
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js', { paths: [root] });

const result = spawnSync(process.execPath, [tauriCli, 'icon', sourceIcon, '--output', iconDirectory], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
