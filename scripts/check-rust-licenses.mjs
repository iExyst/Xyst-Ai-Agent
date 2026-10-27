import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const policyPath = path.resolve(import.meta.dirname, '..', 'licenses', 'rust-policy.json');

export function checkRustLicenseInventory(inventory, policy) {
  validatePolicy(policy);
  if (!Array.isArray(inventory) || inventory.length === 0) throw new TypeError('Rust license inventory must be a non-empty JSON array');
  const allowedLicenses = new Set(policy.allowed_licenses);
  const allowedExceptions = new Set(policy.allowed_exceptions);
  const rejected = [];
  for (const entry of inventory) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('Rust license inventory entries must be objects');
    if (typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.version !== 'string' || !entry.version.trim())
      throw new TypeError('Each Rust license inventory entry must include a package name and version');
    if (typeof entry.license !== 'string' || !entry.license.trim()) {
      rejected.push({ name: entry.name, version: entry.version, license: entry.license ?? 'UNKNOWN', reason: 'missing license metadata' });
      continue;
    }
    try {
      if (!evaluateSpdxExpression(entry.license, allowedLicenses, allowedExceptions))
        rejected.push({ name: entry.name, version: entry.version, license: entry.license, reason: 'no approved license option' });
    } catch (error) {
      rejected.push({
        name: entry.name,
        version: entry.version,
        license: entry.license,
        reason: `invalid SPDX expression: ${error.message}`,
      });
    }
  }
  return { checked: inventory.length, rejected };
}

export function evaluateSpdxExpression(expression, allowedLicenses, allowedExceptions = new Set()) {
  if (typeof expression !== 'string' || !expression.trim()) throw new TypeError('SPDX expression must be a non-empty string');
  if (!(allowedLicenses instanceof Set) || !(allowedExceptions instanceof Set)) throw new TypeError('SPDX policy identifiers must be Sets');
  const tokens = tokenize(expression.trim());
  let position = 0;
  const peek = () => tokens[position];
  const consume = (expected) => {
    const token = tokens[position];
    if (token !== expected) throw new SyntaxError(`expected '${expected}'`);
    position += 1;
    return token;
  };

  function parseOr() {
    let approved = parseAnd();
    while (peek() === 'OR') {
      position += 1;
      const alternative = parseAnd();
      approved = approved || alternative;
    }
    return approved;
  }

  function parseAnd() {
    let approved = parseWith();
    while (peek() === 'AND') {
      position += 1;
      const required = parseWith();
      approved = approved && required;
    }
    return approved;
  }

  function parseWith() {
    const term = parsePrimary();
    let approved = term.approved;
    if (peek() === 'WITH') {
      if (!term.singleLicense) throw new SyntaxError('WITH must follow a single SPDX license identifier');
      position += 1;
      const exception = peek();
      if (!exception || ['AND', 'OR', 'WITH', ')', '('].includes(exception))
        throw new SyntaxError('expected SPDX exception identifier after WITH');
      position += 1;
      approved = approved && allowedExceptions.has(exception);
    }
    return approved;
  }

  function parsePrimary() {
    const token = peek();
    if (!token) throw new SyntaxError('expected SPDX license identifier');
    if (token === '(') {
      position += 1;
      const approved = parseOr();
      consume(')');
      return { approved, singleLicense: false };
    }
    if ([')', 'AND', 'OR', 'WITH'].includes(token)) throw new SyntaxError(`unexpected '${token}'`);
    position += 1;
    return { approved: allowedLicenses.has(token), singleLicense: true };
  }

  const result = parseOr();
  if (position !== tokens.length) throw new SyntaxError(`unexpected '${tokens[position]}'`);
  return result;
}

function tokenize(expression) {
  const tokens = [];
  const tokenPattern = /\s*(\(|\)|AND\b|OR\b|WITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*)/gy;
  let offset = 0;
  while (offset < expression.length) {
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(expression);
    if (!match) throw new SyntaxError(`unsupported token at character ${offset + 1}`);
    tokens.push(match[1]);
    offset = tokenPattern.lastIndex;
  }
  return tokens;
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || policy.schema_version !== 1)
    throw new TypeError('Rust license policy has an unsupported schema version');
  for (const field of ['allowed_licenses', 'allowed_exceptions']) {
    const values = policy[field];
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(value)))
      throw new TypeError(`Rust license policy ${field} must contain SPDX identifiers`);
    if (new Set(values).size !== values.length) throw new TypeError(`Rust license policy ${field} must not contain duplicates`);
  }
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length !== 3)
    throw new Error('Usage: node scripts/check-rust-licenses.mjs <cargo-license-inventory.json>');
  const [inventoryText, policyText] = await Promise.all([fs.readFile(path.resolve(inputPath), 'utf8'), fs.readFile(policyPath, 'utf8')]);
  let inventory;
  let policy;
  try {
    inventory = JSON.parse(inventoryText);
    policy = JSON.parse(policyText);
  } catch (error) {
    throw new Error(`Invalid license JSON: ${error.message}`, { cause: error });
  }
  const result = await checkRustLicenseInventory(inventory, policy);
  if (result.rejected.length) {
    console.error(`Rust license policy rejected ${result.rejected.length} of ${result.checked} packages:`);
    for (const entry of result.rejected) console.error(`- ${entry.name}@${entry.version}: ${entry.license} (${entry.reason})`);
    process.exitCode = 1;
    return;
  }
  console.log(`Rust license policy approved all ${result.checked} packages.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
