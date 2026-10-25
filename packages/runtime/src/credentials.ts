import { Entry } from "@napi-rs/keyring";

export function credentialStoreError(error: unknown, operatingSystem = process.platform): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (operatingSystem === "linux" && /org\.freedesktop\.secrets|secret service|dbus/i.test(message)) {
    return new Error("Linux credential storage requires a running Secret Service on this user's D-Bus session (for example, GNOME Keyring).", { cause: error });
  }
  return new Error(`Operating system credential vault request failed: ${message}`, { cause: error });
}

export class CredentialStore {
  private entry(service: string, name: string): Entry {
    const options = process.platform === "linux" ? { linux: { store: "secret-service" as const } } : undefined;
    return new Entry(`xyst:${service}`, name, options);
  }
  async set(service: string, name: string, secret: string): Promise<void> {
    if (!secret) throw new Error("Credential cannot be empty");
    try { this.entry(service, name).setPassword(secret); }
    catch (error) { throw credentialStoreError(error); }
  }
  async get(service: string, name: string): Promise<string | undefined> {
    try { return this.entry(service, name).getPassword() ?? undefined; }
    catch (error) { throw credentialStoreError(error); }
  }
  async delete(service: string, name: string): Promise<boolean> {
    try { return this.entry(service, name).deleteCredential(); }
    catch (error) { throw credentialStoreError(error); }
  }
}

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s,;]+)/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g
];
export function redactSecrets(value: string, secrets: Array<string | undefined> = []): string {
  let result = value;
  for (const secret of secrets) if (secret && secret.length >= 6) result = result.replaceAll(secret, "[REDACTED]");
  result = result.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@");
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, (...parts: unknown[]) => typeof parts[1] === "string" ? `${parts[1]}[REDACTED]` : "[REDACTED]"), result);
}
