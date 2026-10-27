import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareImageFiles, prepareImageInputs } from '../src/providers/images.mjs';
import { createTempDirectory } from './helpers.mjs';
import { createPng } from './image-fixtures.mjs';

test('image input validates PNG content and returns bounded metadata plus base64', async () => {
  const bytes = createPng(2, 1);
  const [image] = await prepareImageInputs([{ mime_type: 'image/png', data: bytes.toString('base64') }]);
  assert.equal(image.mime_type, 'image/png');
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.equal(image.byte_length, bytes.length);
  assert.match(image.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Buffer.from(image.data, 'base64'), bytes);
});

test('image input rejects malformed base64, false MIME labels, and corrupt PNG chunks', async () => {
  const bytes = createPng(1, 1);
  await assert.rejects(prepareImageInputs([{ mime_type: 'image/png', data: 'not base64!' }]), { code: 'INVALID_IMAGE' });
  await assert.rejects(prepareImageInputs([{ mime_type: 'image/jpeg', data: bytes.toString('base64') }]), { code: 'INVALID_IMAGE_TYPE' });
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 5] ^= 0xff;
  await assert.rejects(prepareImageInputs([{ mime_type: 'image/png', data: corrupt.toString('base64') }]), { code: 'INVALID_IMAGE' });
});

test('large images are preprocessed and validated again before provider use', async () => {
  const source = createPng(2049, 1);
  const resized = createPng(2048, 1, [10, 20, 30]);
  let called = false;
  const [image] = await prepareImageInputs([{ mime_type: 'image/png', data: source.toString('base64') }], {
    processor: async (bytes, mimeType) => {
      called = true;
      assert.deepEqual(bytes, source);
      assert.equal(mimeType, 'image/png');
      return { bytes: resized, mimeType: 'image/png' };
    },
  });
  assert.equal(called, true);
  assert.equal(image.width, 2048);
  assert.equal(image.mime_type, 'image/png');
  await assert.rejects(
    prepareImageInputs([{ mime_type: 'image/png', data: source.toString('base64') }], {
      processor: async () => ({ bytes: source, mimeType: 'image/png' }),
    }),
    { code: 'IMAGE_PROCESSING_FAILED' },
  );
});

test('default image processor resizes an oversized PNG to bounded JPEG output', async () => {
  const source = createPng(2049, 1, [200, 30, 20]);
  const [image] = await prepareImageInputs([{ mime_type: 'image/png', data: source.toString('base64') }]);
  assert.equal(image.mime_type, 'image/jpeg');
  assert.equal(image.width, 2048);
  assert.equal(image.height, 1);
  assert.ok(image.byte_length <= 4 * 1024 * 1024);
});

test('local image paths reject protected files and accept a regular image', async (t) => {
  const root = await createTempDirectory('xyst-image-input-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'diagram.png');
  await fs.writeFile(filePath, createPng(1, 1));
  const [image] = await prepareImageFiles([filePath]);
  assert.equal(image.mime_type, 'image/png');
  const protectedPath = path.join(root, '.env');
  await fs.writeFile(protectedPath, createPng(1, 1));
  await assert.rejects(prepareImageFiles([protectedPath]), { code: 'SENSITIVE_IMAGE_PATH' });
});
