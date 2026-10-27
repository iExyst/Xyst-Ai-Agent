import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { isSensitivePath } from '../platform/redaction.mjs';
import { resolveWindowsPowerShellPath } from '../platform/process.mjs';
import { MAX_IMAGE_COUNT } from '../core/limits.mjs';

const execFileAsync = promisify(execFile);
export { MAX_IMAGE_COUNT };
export const MAX_IMAGE_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 2048;
const MAX_SOURCE_PIXELS = 36_000_000;
const ACCEPTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

/** Load explicitly selected local image files without following links or
 * reading common credential locations, then normalize them for vision APIs.
 */
export async function prepareImageFiles(filePaths, { processor = resizeImage } = {}) {
  if (!Array.isArray(filePaths) || filePaths.length > MAX_IMAGE_COUNT)
    throw new TypeError(`At most ${MAX_IMAGE_COUNT} images may be attached`);
  const images = [];
  for (const filePath of filePaths) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('Image paths must be non-empty strings');
    const resolved = path.resolve(filePath);
    if (isSensitivePath(resolved))
      throw Object.assign(new Error('Images from protected credential locations cannot be attached'), { code: 'SENSITIVE_IMAGE_PATH' });
    const info = await fs.lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink())
      throw Object.assign(new Error('Each image path must name a regular non-symlink file'), { code: 'INVALID_IMAGE_FILE' });
    if (info.size > MAX_IMAGE_SOURCE_BYTES)
      throw Object.assign(new Error(`Each image must be no larger than ${MAX_IMAGE_SOURCE_BYTES} bytes before preprocessing`), {
        code: 'IMAGE_TOO_LARGE',
      });
    const bytes = await fs.readFile(resolved);
    images.push(await prepareImageBytes(bytes, undefined, processor));
  }
  assertTotalBytes(images);
  return images;
}

/** Validate base64 API/browser attachments and prepare bounded image payloads. */
export async function prepareImageInputs(inputs, { processor = resizeImage } = {}) {
  if (inputs === undefined || inputs === null) return [];
  if (!Array.isArray(inputs) || inputs.length > MAX_IMAGE_COUNT)
    throw new TypeError(`images must be an array containing at most ${MAX_IMAGE_COUNT} items`);
  const images = [];
  for (const input of inputs) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['mime_type', 'data', 'byte_length', 'sha256', 'width', 'height'].includes(key)) ||
      typeof input.mime_type !== 'string' ||
      typeof input.data !== 'string'
    ) {
      throw Object.assign(new Error('Each image must contain only mime_type and base64 data'), { code: 'INVALID_IMAGE' });
    }
    if (!ACCEPTED_MIME_TYPES.has(input.mime_type))
      throw Object.assign(new Error('Image MIME type must be image/png, image/jpeg, or image/webp'), { code: 'INVALID_IMAGE_TYPE' });
    const encoded = input.data;
    if (
      !encoded.length ||
      encoded.length > Math.ceil(MAX_IMAGE_SOURCE_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      throw Object.assign(new Error('Image data must be valid bounded base64'), { code: 'INVALID_IMAGE' });
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_SOURCE_BYTES || bytes.toString('base64') !== encoded)
      throw Object.assign(new Error('Image data must be valid bounded base64'), { code: 'INVALID_IMAGE' });
    images.push(await prepareImageBytes(bytes, input.mime_type, processor));
  }
  assertTotalBytes(images);
  return images;
}

async function prepareImageBytes(bytes, declaredMimeType, processor = resizeImage) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_SOURCE_BYTES)
    throw Object.assign(new Error('Image file is empty or exceeds the source size limit'), { code: 'IMAGE_TOO_LARGE' });
  const { mimeType, width, height } = inspectImage(bytes);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw Object.assign(new Error('Image dimensions are invalid'), { code: 'INVALID_IMAGE' });
  if (declaredMimeType && declaredMimeType !== mimeType)
    throw Object.assign(new Error('Image MIME type does not match its file contents'), { code: 'INVALID_IMAGE_TYPE' });
  if (width * height > MAX_SOURCE_PIXELS)
    throw Object.assign(new Error(`Images must not exceed ${MAX_SOURCE_PIXELS} pixels`), { code: 'IMAGE_TOO_MANY_PIXELS' });

  let output = { bytes, mimeType, width, height };
  if (bytes.length > MAX_IMAGE_OUTPUT_BYTES || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    output = await processor(bytes, mimeType);
    const details = inspectImage(output.bytes);
    if (
      details.mimeType !== output.mimeType ||
      details.width > MAX_IMAGE_EDGE ||
      details.height > MAX_IMAGE_EDGE ||
      details.width * details.height > MAX_IMAGE_EDGE ** 2 ||
      output.bytes.length > MAX_IMAGE_OUTPUT_BYTES
    ) {
      throw Object.assign(new Error('Image preprocessing did not produce a bounded supported image'), { code: 'IMAGE_PROCESSING_FAILED' });
    }
    output = { ...output, width: details.width, height: details.height };
  }
  return {
    mime_type: output.mimeType,
    data: output.bytes.toString('base64'),
    byte_length: output.bytes.length,
    sha256: createHash('sha256').update(output.bytes).digest('hex'),
    width: output.width,
    height: output.height,
  };
}

function assertTotalBytes(images) {
  const total = images.reduce((sum, image) => sum + image.byte_length, 0);
  if (total > MAX_IMAGES_TOTAL_BYTES)
    throw Object.assign(new Error(`Combined image payload must be no larger than ${MAX_IMAGES_TOTAL_BYTES} bytes after preprocessing`), {
      code: 'IMAGES_TOO_LARGE',
    });
}

function inspectImage(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return inspectPng(bytes);
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return inspectJpeg(bytes);
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return inspectWebp(bytes);
  throw Object.assign(new Error('Image content must be a valid PNG, JPEG, or WebP file'), { code: 'INVALID_IMAGE_TYPE' });
}

function inspectPng(bytes) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let hasData = false;
  let hasEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > MAX_IMAGE_SOURCE_BYTES || offset + 12 + length > bytes.length) break;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if (pngCrc(bytes, offset + 4, dataEnd) !== expectedCrc)
      throw Object.assign(new Error('PNG contains a corrupt chunk checksum'), { code: 'INVALID_IMAGE' });
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) throw Object.assign(new Error('PNG has an invalid header'), { code: 'INVALID_IMAGE' });
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      if (![1, 2, 4, 8, 16].includes(bytes[dataStart + 8]) || ![0, 2, 3, 4, 6].includes(bytes[dataStart + 9]))
        throw Object.assign(new Error('PNG uses an unsupported pixel encoding'), { code: 'INVALID_IMAGE' });
    }
    if (type === 'IDAT') hasData = true;
    if (type === 'IEND') {
      if (length !== 0 || dataEnd + 4 !== bytes.length)
        throw Object.assign(new Error('PNG has an invalid end marker'), { code: 'INVALID_IMAGE' });
      hasEnd = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height || !hasData || !hasEnd)
    throw Object.assign(new Error('PNG image structure is incomplete'), { code: 'INVALID_IMAGE' });
  return { mimeType: 'image/png', width, height };
}

function pngCrc(bytes, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectJpeg(bytes) {
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (frameMarkers.has(marker) && segmentLength >= 7) {
      if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
        throw Object.assign(new Error('JPEG image is missing its end marker'), { code: 'INVALID_IMAGE' });
      return { mimeType: 'image/jpeg', height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  throw Object.assign(new Error('JPEG image is missing valid dimensions'), { code: 'INVALID_IMAGE' });
}

function inspectWebp(bytes) {
  if (bytes.readUInt32LE(4) + 8 !== bytes.length)
    throw Object.assign(new Error('WebP RIFF size does not match its payload'), { code: 'INVALID_IMAGE' });
  const kind = bytes.toString('ascii', 12, 16);
  if (kind === 'VP8X' && bytes.length >= 30) {
    return { mimeType: 'image/webp', width: readUInt24LE(bytes, 24) + 1, height: readUInt24LE(bytes, 27) + 1 };
  }
  if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { mimeType: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { mimeType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  throw Object.assign(new Error('WebP image is missing supported dimension metadata'), { code: 'INVALID_IMAGE' });
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

async function resizeImage(bytes, mimeType) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xyst-image-'));
  const extension = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
  const inputPath = path.join(directory, `input${extension}`);
  const outputPath = path.join(directory, 'output.jpg');
  try {
    await fs.writeFile(inputPath, bytes, { flag: 'wx', mode: 0o600 });
    if (process.platform === 'win32') await resizeWithWindowsImaging(inputPath, outputPath);
    else await resizeWithImageMagick(inputPath, outputPath);
    const result = await fs.readFile(outputPath);
    const details = inspectImage(result);
    if (details.mimeType !== 'image/jpeg') throw new Error('Image processor returned a non-JPEG result');
    return { bytes: result, mimeType: 'image/jpeg', width: details.width, height: details.height };
  } catch (cause) {
    throw Object.assign(new Error(`Image requires resizing, but preprocessing failed: ${cause.message}`), {
      code: 'IMAGE_PROCESSING_FAILED',
      cause,
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function resizeWithImageMagick(inputPath, outputPath) {
  const args = [inputPath, '-auto-orient', '-resize', `${MAX_IMAGE_EDGE}x${MAX_IMAGE_EDGE}>`, '-strip', '-quality', '85', outputPath];
  try {
    await execFileAsync('magick', args, { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await execFileAsync('convert', args, { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  }
}

async function resizeWithWindowsImaging(inputPath, outputPath) {
  const powershell = resolveWindowsPowerShellPath();
  if (!powershell) throw new Error('Windows PowerShell was not found under SystemRoot or WINDIR');
  const encode = (value) => Buffer.from(value, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; $inputPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(inputPath)}')); $outputPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(outputPath)}')); $source=[System.Drawing.Image]::FromFile($inputPath); try { $scale=[Math]::Min(1.0,[Math]::Min(${MAX_IMAGE_EDGE}.0/$source.Width,${MAX_IMAGE_EDGE}.0/$source.Height)); $width=[Math]::Max(1,[int][Math]::Floor($source.Width*$scale)); $height=[Math]::Max(1,[int][Math]::Floor($source.Height*$scale)); $bitmap=New-Object System.Drawing.Bitmap($width,$height); $graphics=[System.Drawing.Graphics]::FromImage($bitmap); try { $graphics.Clear([System.Drawing.Color]::White); $graphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $graphics.DrawImage($source,0,0,$width,$height); $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }; $parameters=New-Object System.Drawing.Imaging.EncoderParameters(1); $parameters.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]85); $bitmap.Save($outputPath,$codec,$parameters); $parameters.Dispose() } finally { $graphics.Dispose(); $bitmap.Dispose() } } finally { $source.Dispose() }`;
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript], {
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}
