import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { resolveToolPath } from '../platform/paths.mjs';
import { getActiveInstalledPackages } from '../extensions/package-registry.mjs';

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILLS = 128;
const MAX_SKILL_BYTES = 50_000;
const MAX_DESCRIPTION = 240;

/** Reads explicitly configured instruction packages. Skill text is data, never executable policy. */
export class SkillLibrary {
  constructor({ workspaceRoot, directories = [], installedPackages = null } = {}) {
    this.workspaceRoot = workspaceRoot;
    this.directories = directories;
    this.installedPackages = installedPackages;
  }

  async list() {
    const skills = [];
    const names = new Set();
    for (const configuredRoot of this.directories) {
      const root = await resolveToolPath(this.workspaceRoot, configuredRoot, { mustExist: true, machineScope: true });
      const rootStat = await fs.stat(root);
      if (!rootStat.isDirectory()) throw new Error(`Configured skill location is not a directory: ${configuredRoot}`);
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (skills.length >= MAX_SKILLS) throw new Error(`Configured skill locations exceed the ${MAX_SKILLS} skill limit`);
        if (!SKILL_NAME.test(entry.name)) continue;
        const directory = await resolveToolPath(root, entry.name, { mustExist: true, machineScope: false });
        const filePath = path.join(directory, 'SKILL.md');
        let source;
        try {
          source = await readSkillFile(filePath, entry.name);
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        const skill = parseSkill(entry.name, source);
        if (names.has(skill.name)) throw new Error(`Duplicate configured skill name '${skill.name}'`);
        names.add(skill.name);
        skills.push({ ...skill, path: filePath });
      }
    }
    if (this.installedPackages) {
      const installed = await getActiveInstalledPackages(this.installedPackages);
      for (const extension of installed) {
        const bytes = extension.files.get('SKILL.md');
        if (!bytes) throw new Error(`Active signed skill '${extension.package_id}' does not include SKILL.md`);
        if (bytes.byteLength > MAX_SKILL_BYTES)
          throw new Error(`Active signed skill '${extension.package_id}' exceeds ${MAX_SKILL_BYTES} bytes`);
        let source;
        try {
          source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new Error(`Active signed skill '${extension.package_id}' SKILL.md must contain valid UTF-8 text`);
        }
        const skill = parseSkill(extension.package_id, source);
        if (names.has(skill.name)) throw new Error(`Duplicate configured skill name '${skill.name}'`);
        if (skills.length >= MAX_SKILLS) throw new Error(`Configured skill locations exceed the ${MAX_SKILLS} skill limit`);
        names.add(skill.name);
        skills.push({ ...skill, path: path.join(extension.path, 'SKILL.md'), source: extension.package_id });
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(name) {
    if (typeof name !== 'string' || !SKILL_NAME.test(name)) throw new Error('Skill name is invalid');
    const skill = (await this.list()).find((item) => item.name === name);
    if (!skill) throw new Error(`Configured skill '${name}' was not found`);
    return {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source: skill.source || path.basename(path.dirname(skill.path)),
      trust: 'untrusted',
    };
  }
}

async function readSkillFile(filePath, name) {
  const before = await fs.lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Skill '${name}' SKILL.md must be a regular file, not a symlink`);
  if (before.size > MAX_SKILL_BYTES) throw new Error(`Skill '${name}' exceeds ${MAX_SKILL_BYTES} bytes`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error(`Skill '${name}' SKILL.md changed while being opened`);
    const chunks = [];
    let total = 0;
    let position = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(8192, MAX_SKILL_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SKILL_BYTES) throw new Error(`Skill '${name}' exceeds ${MAX_SKILL_BYTES} bytes`);
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new Error(`Skill '${name}' SKILL.md must contain valid UTF-8 text`);
    }
  } finally {
    await handle.close();
  }
}

function parseSkill(directoryName, source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Skill '${directoryName}' must start with a YAML-style name and description header`);
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^(name|description):\s*(.*?)\s*$/);
    if (!field || fields.has(field[1]) || !field[2] || /[\r\n]/.test(field[2]))
      throw new Error(`Skill '${directoryName}' has invalid or unsupported header metadata`);
    fields.set(
      field[1],
      field[2].replace(/^(?:"([^"]*)"|'([^']*)')$/, (_whole, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted),
    );
  }
  const name = fields.get('name');
  const description = fields.get('description');
  const content = match[2].trim();
  if (!SKILL_NAME.test(name || '') || name !== directoryName)
    throw new Error(`Skill name must be a lowercase hyphenated identifier matching directory '${directoryName}'`);
  if (!description || description.length > MAX_DESCRIPTION)
    throw new Error(`Skill '${directoryName}' description must be 1–${MAX_DESCRIPTION} characters`);
  if (!content) throw new Error(`Skill '${directoryName}' body must not be empty`);
  return { name, description, content };
}
