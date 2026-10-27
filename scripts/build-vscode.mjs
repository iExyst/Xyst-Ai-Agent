import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const destination = path.join(root, 'vscode', 'dist', 'api-client.mjs');
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.copyFile(path.join(root, 'src', 'api', 'client.mjs'), destination);
console.log(`Built VS Code API client: ${path.relative(root, destination)}`);
