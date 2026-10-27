import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const extensionRoot = path.join(root, 'vscode');
const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
assert.equal(manifest.main, './extension.js');
assert.ok(manifest.engines?.vscode);
assert.ok(manifest.contributes?.commands?.some(({ command }) => command === 'xyst.startChat'));
const settings = manifest.contributes?.configuration?.properties || {};
for (const key of ['xyst.cliPath', 'xyst.nodePath', 'xyst.maxAttachedSelectionCharacters'])
  assert.ok(settings[key], `missing setting ${key}`);
assert.ok(
  Object.keys(settings).every((key) => key.startsWith('xyst.')),
  'all extension settings must use the Xyst namespace',
);
for (const command of ['xyst.startReview', 'xyst.startPlan', 'xyst.cancelRun', 'xyst.openSettings'])
  assert.ok(
    manifest.contributes.commands.some((item) => item.command === command),
    `missing command ${command}`,
  );
for (const file of ['extension.js', 'media/chat.html', 'media/chat.css', 'media/chat.js', 'media/xyst-icon.png', 'README.md'])
  await fs.access(path.join(extensionRoot, file));
const html = await fs.readFile(path.join(extensionRoot, 'media', 'chat.html'), 'utf8');
assert.match(html, /default-src 'none'/);
assert.match(html, /__NONCE__/);
assert.match(html, /connect-src 'none'/);
assert.match(html, /img-src __CSP_SOURCE__ data:/);
assert.match(html, /__ICON_URI__/);
assert.doesNotMatch(JSON.stringify(manifest), /"(dependencies|devDependencies)"\s*:/);
await fs.access(path.join(extensionRoot, 'dist', 'api-client.mjs'));
console.log('VS Code extension package structure and webview policy are valid.');
