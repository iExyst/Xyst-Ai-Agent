const SECRET_ASSIGNMENT =
  /((?:"[^"\r\n]+"|'[^'\r\n]+'|[A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|Bearer\s+[^\s,;#]+|[^\s,;#]+)/gi;
const SECRET_FIELD_NAME =
  /^(?:[a-z0-9]+_)*(?:api_?key|access_?token|refresh_?token|auth(?:orization|_?token)?|client_?secret|private_?key|key|token|secret|password|passwd|credential)(?:_value)?$/;
const SECRET_REFERENCE_FIELD_NAME = /^(?:api_key_secret|(?:secret|credential|token|key)_(?:ref|name|id))$/;

export function redactSecrets(input, depth = 0) {
  let value = String(input);
  const trimmed = value.trimStart();
  if (depth < 32 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        const safe = redactStructuredSecrets(parsed, depth + 1);
        if (JSON.stringify(safe) !== JSON.stringify(parsed)) return JSON.stringify(safe);
      }
    } catch {
      // Non-JSON text continues through the string-level filters below.
    }
  }
  value = value.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  value = value.replace(
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g,
    '[REDACTED TOKEN]',
  );
  value = value.replace(SECRET_ASSIGNMENT, (match, prefix) => {
    const separator = Math.max(prefix.lastIndexOf(':'), prefix.lastIndexOf('='));
    const label = prefix
      .slice(0, separator)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    return isSecretFieldName(label) ? `${prefix}[REDACTED]` : match;
  });
  return value;
}

/** Redact strings in JSON-like persisted data without changing its shape. */
export function redactStructuredSecrets(value, depth = 0) {
  if (typeof value === 'string') return redactSecrets(value, depth + 1);
  if (depth >= 32) return '[OMITTED: excessive nesting]';
  if (Array.isArray(value)) return value.map((item) => redactStructuredSecrets(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSecretFieldName(key) ? (item === null || item === undefined ? item : '[REDACTED]') : redactStructuredSecrets(item, depth + 1),
      ]),
    );
  }
  return value;
}

export function isSecretFieldName(value) {
  if (typeof value !== 'string') return false;
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return SECRET_FIELD_NAME.test(normalized) && !SECRET_REFERENCE_FIELD_NAME.test(normalized);
}

export function containsSensitiveMaterial(input) {
  const source = String(input);
  return redactSecrets(source) !== source;
}

export function isSensitivePath(filePath) {
  const segments = String(filePath)
    .replaceAll('\\', '/')
    .split('/')
    .map((part) => part.toLowerCase());
  const name = segments.at(-1) || '';
  if (segments.includes('.agent')) return true;
  if (segments.some((part) => ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure'].includes(part))) return true;
  if (segments.join('/').includes('/.config/gh/') || segments.join('/').includes('/.config/gcloud/')) return true;
  if (
    [
      '.npmrc',
      '.pypirc',
      '.netrc',
      '.htpasswd',
      'credentials',
      'credentials.json',
      'application_default_credentials.json',
      'terraform.tfstate',
      'terraform.tfstate.backup',
      '.envrc',
    ].includes(name)
  )
    return true;
  if (/^\.env(?:\..+)?$/.test(name) && !['.env.example', '.env.sample', '.env.template'].includes(name)) return true;
  if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|keystore))$/.test(name)) return true;
  if (/^(?:secrets?|credentials?)(?:\.(?:json|ya?ml|ini|toml|txt))?$/.test(name)) return true;
  if (/^service[-_]account.*\.json$/.test(name)) return true;
  if (/^terraform\.tfstate(?:\..*)?$/.test(name)) return true;
  return false;
}
