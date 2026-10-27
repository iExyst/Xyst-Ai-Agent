/** Parse the TOML value forms used by Xyst AI Assistant configuration.
 * Deliberately rejects constructs not implemented here rather than guessing.
 */
const DECIMAL_FLOAT =
  /^[+-]?(?:[0-9](?:_?[0-9])*\.[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?|[0-9](?:_?[0-9])*[eE][+-]?[0-9](?:_?[0-9])*)$/;
const BASE_INTEGER = /^0(?:[xX][0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/;

export function parseToml(source) {
  const root = {};
  let table = root;
  const arrayTables = new WeakSet();
  const explicitTables = new WeakSet();
  const inlineTables = new WeakSet();
  const lines = String(source).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    let raw = stripComment(lines[index]).trim();
    if (!raw) continue;
    const lineNumber = index + 1;
    const multiline = multilineOpening(raw);
    if (multiline) {
      const openingAt = raw.indexOf(multiline) + multiline.length;
      let statement = raw;
      while (findMultilineEnd(statement, multiline, openingAt) < 0) {
        index += 1;
        if (index >= lines.length) throw new SyntaxError(`Unclosed multiline string on line ${lineNumber}`);
        statement += `\n${lines[index]}`;
      }
      raw = stripComment(statement).trim();
    }
    while (containerDepth(raw) > 0) {
      index += 1;
      if (index >= lines.length) throw new SyntaxError(`Unclosed array or inline table on line ${lineNumber}`);
      raw += `\n${stripComment(lines[index])}`;
    }
    if (containerDepth(raw) < 0) throw new SyntaxError(`Unexpected closing delimiter on line ${lineNumber}`);

    const arraySection = raw.startsWith('[[') && raw.endsWith(']]') ? raw.slice(2, -2).trim() : null;
    if (arraySection !== null) {
      const parts = parseDottedKey(arraySection, lineNumber);
      const parent = getOrCreateTable(root, parts.slice(0, -1), lineNumber, arrayTables, inlineTables, true);
      const key = parts.at(-1);
      assertSafeKey(key, lineNumber);
      if (Object.hasOwn(parent, key) && (!Array.isArray(parent[key]) || !arrayTables.has(parent[key]))) {
        throw new SyntaxError(`Array-of-tables conflicts with a value on line ${lineNumber}`);
      }
      const array = (parent[key] ??= []);
      table = {};
      array.push(table);
      arrayTables.add(array);
      continue;
    }

    const section = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1).trim() : null;
    if (section !== null) {
      const parts = parseDottedKey(section, lineNumber);
      table = getOrCreateTable(root, parts, lineNumber, arrayTables, inlineTables);
      if (explicitTables.has(table)) throw new SyntaxError(`Duplicate table '${section}' on line ${lineNumber}`);
      explicitTables.add(table);
      continue;
    }
    if (raw.startsWith('[')) {
      throw new SyntaxError(`Unsupported table syntax on line ${lineNumber}`);
    }

    const separator = findUnquoted(raw, '=');
    if (separator < 1) throw new SyntaxError(`Expected key = value on line ${lineNumber}`);
    const keySource = raw.slice(0, separator).trim();
    const valueSource = raw.slice(separator + 1);
    const parts = parseDottedKey(keySource, lineNumber);
    let target = table;
    for (const part of parts.slice(0, -1)) {
      assertSafeKey(part, lineNumber);
      if (Object.hasOwn(target, part) && (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part]))) {
        throw new SyntaxError(`Dotted key conflicts with a value on line ${lineNumber}`);
      }
      if (inlineTables.has(target[part])) throw new SyntaxError(`Inline tables cannot be extended on line ${lineNumber}`);
      target = target[part] ??= {};
    }
    const key = parts.at(-1);
    if (Object.hasOwn(target, key)) throw new SyntaxError(`Duplicate key '${keySource}' on line ${lineNumber}`);
    target[key] = parseValue(valueSource, lineNumber, inlineTables);
  }
  return root;
}

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !escaped) quote = quote === char ? null : (quote ?? char);
    if (char === '#' && quote === null) return line.slice(0, i);
    escaped = false;
  }
  return line;
}

function getOrCreateTable(root, parts, lineNumber, arrayTables, inlineTables, allowArrayLeaf = false) {
  let node = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    assertSafeKey(part, lineNumber);
    if (Object.hasOwn(node, part) && Array.isArray(node[part])) {
      if (!arrayTables.has(node[part]) || !node[part].length || (index === parts.length - 1 && !allowArrayLeaf))
        throw new SyntaxError(`Table conflicts with a value on line ${lineNumber}`);
      node = node[part].at(-1);
      continue;
    }
    if (inlineTables.has(node[part])) throw new SyntaxError(`Inline tables cannot be extended on line ${lineNumber}`);
    if (Object.hasOwn(node, part) && (!node[part] || typeof node[part] !== 'object'))
      throw new SyntaxError(`Table conflicts with a value on line ${lineNumber}`);
    node[part] ??= {};
    node = node[part];
  }
  return node;
}

function assertSafeKey(key, lineNumber) {
  if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new SyntaxError(`Unsafe key '${key}' on line ${lineNumber}`);
}

function parseDottedKey(source, lineNumber) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !escaped) quote = quote === char ? null : (quote ?? char);
    if (char === '.' && quote === null) {
      parts.push(parseKey(source.slice(start, index), lineNumber));
      start = index + 1;
    }
    escaped = false;
  }
  if (quote !== null) throw new SyntaxError(`Unclosed quoted key on line ${lineNumber}`);
  parts.push(parseKey(source.slice(start), lineNumber));
  for (const part of parts) assertSafeKey(part, lineNumber);
  return parts;
}

function parseKey(source, lineNumber) {
  const key = source.trim();
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  if (key === '""' || key === "''") return '';
  if (key.startsWith('"')) {
    try {
      const parsed = JSON.parse(key);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* stable parser-specific diagnostic */
    }
  } else if (key.startsWith("'") && /^'[^'\r\n]*'$/.test(key)) return key.slice(1, -1);
  throw new SyntaxError(`Invalid key '${key}' on line ${lineNumber}`);
}

function containerDepth(source) {
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (const char of source) {
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !escaped) quote = quote === char ? null : (quote ?? char);
    else if (quote === null && (char === '[' || char === '{')) depth += 1;
    else if (quote === null && (char === ']' || char === '}')) depth -= 1;
    escaped = false;
  }
  return depth;
}

function parseValue(source, lineNumber, inlineTables) {
  const value = source.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[+-]?(?:inf|nan)$/i.test(value))
    return value.toLowerCase().includes('nan') ? Number.NaN : value.startsWith('-') ? -Infinity : Infinity;
  if (isDateTime(value)) return value;
  const integer = value.match(/^[+-]?(?:0|[1-9](?:_?[0-9])*)$/);
  if (integer) return Number(value.replaceAll('_', ''));
  const basedInteger = value.match(BASE_INTEGER);
  if (basedInteger)
    return Number.parseInt(
      value.slice(2).replaceAll('_', ''),
      value[1].toLowerCase() === 'x' ? 16 : value[1].toLowerCase() === 'o' ? 8 : 2,
    );
  const float = value.match(DECIMAL_FLOAT);
  if (float) return Number(value.replaceAll('_', ''));
  if (value.startsWith('"""') && value.endsWith('"""')) return parseMultilineBasic(value.slice(3, -3), lineNumber);
  if (value.startsWith("'''") && value.endsWith("'''")) return parseMultilineLiteral(value.slice(3, -3), lineNumber);
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* include a stable line-specific diagnostic below */
    }
    throw new SyntaxError(`Invalid basic string on line ${lineNumber}`);
  }
  if (value.startsWith("'")) {
    if (!/^'[^'\r\n]*'$/.test(value)) throw new SyntaxError(`Invalid literal string on line ${lineNumber}`);
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const body = value.slice(1, -1).trim();
    if (!body) return [];
    const parts = splitArray(body, lineNumber);
    const values = parts.map((part) => parseValue(part, lineNumber, inlineTables));
    const kinds = new Set(parts.map((part, index) => valueKind(part, values[index])));
    if (kinds.size > 1) throw new SyntaxError(`Mixed value types in array on line ${lineNumber}`);
    return values;
  }
  if (value.startsWith('{') && value.endsWith('}')) return parseInlineTable(value.slice(1, -1), lineNumber, inlineTables);
  throw new SyntaxError(`Unsupported value on line ${lineNumber}`);
}

function valueKind(source, parsed) {
  const value = source.trim();
  if (isDateTime(value)) return 'datetime';
  if (value === 'true' || value === 'false') return 'boolean';
  if (/^[+-]?(?:inf|nan)$/i.test(value) || DECIMAL_FLOAT.test(value)) return 'float';
  if (BASE_INTEGER.test(value)) return 'integer';
  if (typeof parsed === 'number') return 'integer';
  if (typeof parsed === 'string') return 'string';
  if (Array.isArray(parsed)) return 'array';
  return 'table';
}

function isDateTime(value) {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date) return validDate(+date[1], +date[2], +date[3]);
  const localTime = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value);
  if (localTime) return validTime(+localTime[1], +localTime[2], +localTime[3]);
  const datetime = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([Zz]|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!datetime || !isDateTime(datetime[1]) || !isDateTime(datetime[2])) return false;
  if (!datetime[3] || /^[Zz]$/.test(datetime[3])) return true;
  const [hours, minutes] = datetime[3].slice(1).split(':').map(Number);
  return hours <= 23 && minutes <= 59;
}

function validTime(hour, minute, second) {
  return hour <= 23 && minute <= 59 && second <= 60;
}

function validDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function multilineOpening(source) {
  const equal = findUnquoted(source, '=');
  if (equal < 0) return null;
  const value = source.slice(equal + 1).trimStart();
  return value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : null;
}

function findMultilineEnd(source, delimiter, start) {
  for (let index = start; index <= source.length - 3; index += 1) {
    if (!source.startsWith(delimiter, index)) continue;
    if (delimiter === '"""') {
      let slashes = 0;
      for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1;
      if (slashes % 2) continue;
    }
    return index;
  }
  return -1;
}

function parseMultilineLiteral(source, lineNumber) {
  let value = source.replaceAll('\r\n', '\n');
  if (value.startsWith('\n')) value = value.slice(1);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    throw new SyntaxError(`Invalid control character in multiline string on line ${lineNumber}`);
  return value;
}

function parseMultilineBasic(source, lineNumber) {
  let body = source.replaceAll('\r\n', '\n');
  if (body.startsWith('\n')) body = body.slice(1);
  let result = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(char))
        throw new SyntaxError(`Invalid control character in multiline string on line ${lineNumber}`);
      result += char;
      continue;
    }
    const escapeCharacter = body[++index];
    if (escapeCharacter === '\n') {
      while (index + 1 < body.length && /[\t \n]/.test(body[index + 1])) index += 1;
      continue;
    }
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (Object.hasOwn(simple, escapeCharacter)) {
      result += simple[escapeCharacter];
      continue;
    }
    if (escapeCharacter === 'u' || escapeCharacter === 'U') {
      const length = escapeCharacter === 'u' ? 4 : 8;
      const digits = body.slice(index + 1, index + 1 + length);
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(digits))
        throw new SyntaxError(`Invalid Unicode escape in multiline string on line ${lineNumber}`);
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
        throw new SyntaxError(`Invalid Unicode scalar in multiline string on line ${lineNumber}`);
      result += String.fromCodePoint(codePoint);
      index += length;
      continue;
    }
    throw new SyntaxError(`Invalid escape in multiline string on line ${lineNumber}`);
  }
  return result;
}

function parseInlineTable(body, lineNumber, inlineTables) {
  const result = {};
  inlineTables.add(result);
  if (body.trimEnd().endsWith(',')) throw new SyntaxError(`Trailing comma in inline table on line ${lineNumber}`);
  for (const entry of splitArray(body, lineNumber)) {
    const separator = findUnquoted(entry, '=');
    if (separator < 1) throw new SyntaxError(`Invalid inline table on line ${lineNumber}`);
    const keySource = entry.slice(0, separator).trim();
    const keyParts = parseDottedKey(keySource, lineNumber);
    let target = result;
    for (const rawKey of keyParts.slice(0, -1)) {
      const key = rawKey;
      if (Object.hasOwn(target, key) && (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])))
        throw new SyntaxError(`Inline table key conflict on line ${lineNumber}`);
      if (inlineTables.has(target[key])) throw new SyntaxError(`Inline tables cannot be extended on line ${lineNumber}`);
      target = target[key] ??= {};
    }
    const key = keyParts.at(-1);
    if (Object.hasOwn(target, key)) throw new SyntaxError(`Duplicate inline table key '${key}' on line ${lineNumber}`);
    target[key] = parseValue(entry.slice(separator + 1), lineNumber, inlineTables);
  }
  return result;
}

function findUnquoted(source, needle) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !escaped) quote = quote === char ? null : (quote ?? char);
    if (char === needle && quote === null) return index;
    escaped = false;
  }
  return -1;
}

function splitArray(body, lineNumber) {
  const values = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !escaped) quote = quote === char ? null : (quote ?? char);
    if (quote === null && (char === '[' || char === '{')) depth += 1;
    if (quote === null && (char === ']' || char === '}')) depth -= 1;
    if (char === ',' && quote === null && depth === 0) {
      const item = body.slice(start, i).trim();
      if (!item) throw new SyntaxError(`Empty array item on line ${lineNumber}`);
      values.push(item);
      start = i + 1;
    }
    escaped = false;
  }
  if (quote !== null) throw new SyntaxError(`Unclosed string in array on line ${lineNumber}`);
  const tail = body.slice(start).trim();
  if (tail) values.push(tail);
  return values;
}
