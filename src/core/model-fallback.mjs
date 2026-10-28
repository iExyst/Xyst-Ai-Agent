import { redactSecrets } from './redaction.mjs';

const FALLBACK_CAUSES = Object.freeze({
  AUTHENTICATION_FAILED: 'provider rejected its credentials',
  CONNECTION_FAILED: 'provider connection failed',
  INVALID_RESPONSE: 'provider returned an invalid response',
  INVALID_STREAM: 'provider stream was invalid',
  PROVIDER_UNAVAILABLE: 'provider was unavailable',
  RATE_LIMITED: 'provider rate limit reached',
  REQUEST_TIMEOUT: 'provider request timed out',
  STREAM_FAILED: 'provider stream failed',
});

export function formatModelFallbackActivity(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : event;
  const from = safeLabel(data?.from_model, 'previous model', 80);
  const to = safeLabel(data?.to_model, 'next model', 80);
  const cause = typeof data?.cause === 'string' ? (FALLBACK_CAUSES[data.cause] ?? 'provider request failed') : 'provider request failed';
  const reason = safeLabel(data?.reason, '', 180);
  return `Model fallback · ${from} → ${to} · ${cause}${reason ? ` · ${reason}` : ''}`;
}

function safeLabel(value, fallback, maxLength) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return redactSecrets(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
