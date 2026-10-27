/** Read and decode a JSON response without allowing its body to grow unbounded. */
export async function readBoundedJsonResponse(response, maxBytes, label = 'Provider response') {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  if (typeof response.body?.getReader !== 'function') throw new Error(`${label} has no readable body stream`);

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (cause) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause });
  }
  return decodeJson(text, label);
}

/** Read a small diagnostic prefix from a response without buffering the full body. */
export async function readBoundedTextResponse(response, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');
  if (!response.body?.getReader) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const size = Math.min(value.byteLength, maxBytes - bytes);
      if (size) {
        chunks.push(value.slice(0, size));
        bytes += size;
      }
      if (size < value.byteLength || bytes === maxBytes) {
        void reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    void reader.cancel().catch(() => {});
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function decodeJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`${label} is not valid JSON`, { cause });
  }
}
