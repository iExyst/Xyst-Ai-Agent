export function withStartupTimeout(label, request, timeoutMs = 10_000) {
  if (typeof label !== 'string' || !label.trim()) throw new TypeError('Startup request label is required');
  if (typeof request !== 'function') throw new TypeError('Startup request must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Startup timeout must be a positive integer');

  const controller = new AbortController();
  let timeout;
  const timeoutError = new Error(`Timed out waiting for ${label}. Reload Xyst AI Assistant to try again.`);
  timeoutError.name = 'TimeoutError';
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve().then(() => request(controller.signal)), deadline]).finally(() => clearTimeout(timeout));
}
