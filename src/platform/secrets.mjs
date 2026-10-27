import { spawn } from 'node:child_process';
import { resolveWindowsPowerShellPath } from './process.mjs';

/** Interface boundary for OS credential vaults. Do not serialize secret values. */
export class SecretStore {
  async get(_key) {
    throw new Error('SecretStore.get is not implemented');
  }
  async set(_key, _value) {
    throw new Error('SecretStore.set is not implemented');
  }
  async delete(_key) {
    throw new Error('SecretStore.delete is not implemented');
  }
  async listKeys() {
    throw new Error('SecretStore.listKeys is not implemented');
  }
}

/** Process-local implementation for unit tests and non-persistent development. */
export class InMemorySecretStore extends SecretStore {
  #values = new Map();
  async get(key) {
    return this.#values.get(validateKey(key)) ?? null;
  }
  async set(key, value) {
    if (typeof value !== 'string') throw new TypeError('Secret values must be strings');
    this.#values.set(validateKey(key), value);
  }
  async delete(key) {
    return this.#values.delete(validateKey(key));
  }
  async listKeys() {
    return [...this.#values.keys()].sort();
  }
}

/** Read-only adapter for environment variable secrets; values stay out of config. */
export class EnvironmentSecretStore extends SecretStore {
  constructor(env = process.env, prefix = '') {
    super();
    this.env = env;
    this.prefix = prefix;
  }
  async get(key) {
    return this.env[`${this.prefix}${validateKey(key)}`] ?? null;
  }
  async set() {
    throw new Error('Environment secrets are read-only');
  }
  async delete() {
    throw new Error('Environment secrets are read-only');
  }
  async listKeys() {
    return Object.keys(this.env)
      .filter((key) => key.startsWith(this.prefix))
      .map((key) => key.slice(this.prefix.length))
      .sort();
  }
}

/** Selects the native, user-scoped credential vault. There is deliberately no plaintext fallback. */
export function createPlatformSecretStore({ platform = process.platform, run = runSecretCommand } = {}) {
  if (platform === 'win32') return new WindowsCredentialStore({ run });
  if (platform === 'linux') return new LinuxSecretServiceStore({ run });
  throw new Error(`No supported OS credential vault for platform '${platform}'`);
}

/** Windows Credential Manager generic credentials, scoped to the current Windows user. */
export class WindowsCredentialStore extends SecretStore {
  constructor({ run = runSecretCommand, powershell = resolveWindowsPowerShellPath() } = {}) {
    super();
    this.run = run;
    this.powershell = powershell;
  }
  async get(key) {
    const response = await this.#invoke({ op: 'get', key: validateKey(key) });
    return response.found ? response.value : null;
  }
  async set(key, value) {
    if (typeof value !== 'string' || !value) throw new TypeError('Secret values must be non-empty strings');
    if (Buffer.byteLength(value, 'utf16le') > 5_120 || /[\u0000\r\n]/.test(value))
      throw new TypeError('Credential value exceeds the OS vault limit or contains unsupported control characters');
    await this.#invoke({ op: 'set', key: validateKey(key), value });
  }
  async delete(key) {
    return (await this.#invoke({ op: 'delete', key: validateKey(key) })).deleted;
  }
  async listKeys() {
    return (await this.#invoke({ op: 'list' })).keys;
  }
  async #invoke(request) {
    if (typeof this.powershell !== 'string') throw new Error('Windows PowerShell was not found under SystemRoot or WINDIR');
    const input = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
    const result = await this.run(
      this.powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_CREDENTIAL_SCRIPT],
      input,
    );
    if (result.exitCode !== 0 || result.truncated) throw new Error('Windows Credential Manager is unavailable or rejected the request');
    try {
      return JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'));
    } catch {
      throw new Error('Windows Credential Manager returned an invalid response');
    }
  }
}

/** Linux Secret Service adapter using libsecret's secret-tool command-line client. */
export class LinuxSecretServiceStore extends SecretStore {
  constructor({ run = runSecretCommand, executable = 'secret-tool', dbusExecutable = 'gdbus' } = {}) {
    super();
    this.run = run;
    this.executable = executable;
    this.dbusExecutable = dbusExecutable;
  }
  async get(key) {
    const safeKey = validateKey(key);
    const result = await this.#run(['lookup', 'service', 'xyst-agent', 'key', safeKey]);
    if (result.exitCode === 1 && !result.stdout) return null;
    if (result.exitCode !== 0 || result.truncated) throw new Error('Linux Secret Service is unavailable or rejected the request');
    return result.stdout.replace(/\r?\n$/, '');
  }
  async set(key, value) {
    if (typeof value !== 'string' || !value) throw new TypeError('Secret values must be non-empty strings');
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024 || /[\u0000\r\n]/.test(value))
      throw new TypeError('Credential value exceeds the supported limit or contains unsupported control characters');
    const result = await this.#run(
      ['store', '--label=Xyst AI Assistant credential', 'service', 'xyst-agent', 'key', validateKey(key)],
      value,
    );
    if (result.exitCode !== 0 || result.truncated) throw new Error('Linux Secret Service is unavailable or rejected the request');
  }
  async delete(key) {
    const safeKey = validateKey(key);
    const result = await this.#run(['clear', 'service', 'xyst-agent', 'key', safeKey]);
    if ((result.exitCode !== 0 && result.exitCode !== 1) || result.truncated)
      throw new Error('Linux Secret Service is unavailable or rejected the request');
    return result.exitCode === 0;
  }
  async listKeys() {
    const collectionOutput = await this.#readProperty('/org/freedesktop/secrets', 'org.freedesktop.Secret.Service', 'Collections');
    const collections = parseSecretServiceObjectPaths(collectionOutput);
    if (collections.length > 64) throw new Error('Linux Secret Service has too many collections to enumerate safely');

    const keys = new Set();
    let itemCount = 0;
    for (const collection of collections) {
      const search = await this.#runGdbus([
        'call',
        '--session',
        '--dest',
        'org.freedesktop.secrets',
        '--object-path',
        collection,
        '--method',
        'org.freedesktop.Secret.Collection.SearchItems',
        "{'service': 'xyst-agent'}",
      ]);
      const items = parseSecretServiceObjectPaths(search.stdout);
      itemCount += items.length;
      if (itemCount > 512) throw new Error('Linux Secret Service has too many Xyst AI Assistant credentials to enumerate safely');
      for (const item of items) {
        const attributes = await this.#readProperty(item, 'org.freedesktop.Secret.Item', 'Attributes');
        const key = parseXystSecretKey(attributes);
        if (key) keys.add(key);
      }
    }
    return [...keys].sort();
  }
  async #readProperty(objectPath, interfaceName, propertyName) {
    const result = await this.#runGdbus([
      'call',
      '--session',
      '--dest',
      'org.freedesktop.secrets',
      '--object-path',
      objectPath,
      '--method',
      'org.freedesktop.DBus.Properties.Get',
      interfaceName,
      propertyName,
    ]);
    return result.stdout;
  }
  async #runGdbus(args) {
    let result;
    try {
      result = await this.run(this.dbusExecutable, args, '');
    } catch {
      throw new Error('Linux Secret Service is unavailable or rejected the request');
    }
    if (result.exitCode !== 0 || result.truncated) throw new Error('Linux Secret Service is unavailable or returned invalid metadata');
    return result;
  }
  async #run(args, input = '') {
    let result;
    try {
      result = await this.run(this.executable, args, input);
    } catch {
      throw new Error('Linux Secret Service is unavailable or rejected the request');
    }
    return result;
  }
}

function parseSecretServiceObjectPaths(output) {
  if (typeof output !== 'string' || !/^\s*\([\s\S]*\)\s*$/.test(output)) throw new Error('Linux Secret Service returned invalid metadata');
  const array = /\[([\s\S]*?)\]/.exec(output);
  if (!array) throw new Error('Linux Secret Service returned invalid metadata');
  const entries = [...array[1].matchAll(/(?:objectpath\s+)?'([^']+)'/g)];
  const paths = entries.map((match) => match[1]);
  if (paths.some((objectPath) => !/^\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/.test(objectPath)))
    throw new Error('Linux Secret Service returned invalid metadata');
  if (array[1].replace(/(?:objectpath\s+)?'[^']+'/g, '').replace(/[\s,]/g, ''))
    throw new Error('Linux Secret Service returned invalid metadata');
  return paths;
}

function parseXystSecretKey(output) {
  if (typeof output !== 'string' || !/^\s*\([\s\S]*\)\s*$/.test(output)) throw new Error('Linux Secret Service returned invalid metadata');
  const service = /'service': '([^']*)'/.exec(output)?.[1];
  if (service !== 'xyst-agent') return null;
  const key = /'key': '([^']*)'/.exec(output)?.[1];
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key || '') ? key : null;
}

/** Run a vault helper with a bounded pipe. Neither input nor diagnostic output is placed in argv. */
function runSecretCommand(command, args, input = '') {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 64 * 1024)
    throw new TypeError('Secret input exceeds the supported size');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: secretHelperEnvironment(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('OS credential helper timed out'));
    }, 10_000);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    child.stdout.on('data', (chunk) => {
      const remaining = Math.max(0, 64 * 1024 - size);
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      size += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) truncated = true;
    });
    child.once('error', () => finish(new Error('OS credential helper could not be started')));
    child.once('close', (exitCode) => finish(null, { stdout: Buffer.concat(chunks).toString('utf8'), exitCode, truncated }));
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
  });
}

function secretHelperEnvironment() {
  const source = process.env;
  const allowed =
    process.platform === 'win32'
      ? ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']
      : ['PATH', 'HOME', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'LANG'];
  return Object.fromEntries(allowed.filter((key) => typeof source[key] === 'string').map((key) => [key, source[key]]));
}

// Kept as a fixed script; all caller data arrives as JSON on stdin, never executable PowerShell text.
const WINDOWS_CREDENTIAL_SCRIPT = Buffer.from(
  `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class XystCred {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CRED { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target, UInt32 type, UInt32 flags, out IntPtr credential);
 [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Write(ref CRED credential, UInt32 flags);
 [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Delete(string target, UInt32 type, UInt32 flags);
 [DllImport("Advapi32.dll", EntryPoint="CredEnumerateW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Enumerate(string filter, UInt32 flags, out UInt32 count, out IntPtr credentials);
 [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
'@
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
$prefix = 'XystAgent:'
function emit($obj) { $json = $obj | ConvertTo-Json -Compress -Depth 4; [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))) }
if ($req.op -eq 'list') {
 $keys=@()
 $count=0; $items=[IntPtr]::Zero
 $ok=[XystCred]::Enumerate($prefix + '*', 0, [ref]$count, [ref]$items); $err=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
 if (!$ok -and $err -ne 1168) { throw 'credential enumeration failed' }
 if ($ok) { try { for ($i=0; $i -lt $count; $i++) { $ptr=[Runtime.InteropServices.Marshal]::ReadIntPtr($items, $i*[IntPtr]::Size); $c=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[type][XystCred+CRED]); if ($c.TargetName.StartsWith($prefix,[StringComparison]::Ordinal)) { $keys += $c.TargetName.Substring($prefix.Length) } } } finally { [XystCred]::CredFree($items) } }
 emit @{ keys=@($keys | Sort-Object -Unique) }; exit 0
}
$target = $prefix + $req.key
if ($req.op -eq 'get') { $p=[IntPtr]::Zero; if (![XystCred]::Read($target,1,0,[ref]$p)) { emit @{ found=$false }; exit 0 }; try { $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][XystCred+CRED]); $value=[Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob,[int]($c.CredentialBlobSize/2)); emit @{ found=$true; value=$value } } finally { [XystCred]::CredFree($p) }; exit 0 }
if ($req.op -eq 'delete') { $ok=[XystCred]::Delete($target,1,0); $err=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); if (!$ok -and $err -ne 1168) { throw 'credential delete failed' }; emit @{ deleted=$ok }; exit 0 }
if ($req.op -eq 'set') { $bytes=[Text.Encoding]::Unicode.GetBytes([string]$req.value); $pin=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length); try { [Runtime.InteropServices.Marshal]::Copy($bytes,0,$pin,$bytes.Length); $c=New-Object XystCred+CRED; $c.Type=1; $c.TargetName=$target; $c.UserName=[Environment]::UserName; $c.CredentialBlob=$pin; $c.CredentialBlobSize=[uint32]$bytes.Length; $c.Persist=2; if (![XystCred]::Write([ref]$c,0)) { throw 'credential write failed' }; emit @{ stored=$true } } finally { for ($i=0; $i -lt $bytes.Length; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($pin,$i,0) }; [Runtime.InteropServices.Marshal]::FreeHGlobal($pin) }; exit 0 }
throw 'unsupported operation'
`,
  'utf16le',
).toString('base64');

function validateKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key)) throw new TypeError('Invalid secret key');
  return key;
}
