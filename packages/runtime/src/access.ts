import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

export type AccessMode = "full" | "restricted";
export interface AccessProfile {
  mode: AccessMode;
  readRoots?: string[];
  writeRoots?: string[];
  allowedExecutables?: string[];
  network?: boolean;
  integrations?: boolean;
  backgroundJobs?: boolean;
  externalActions?: boolean;
}
type AccessCapability = "network" | "integrations" | "backgroundJobs" | "externalActions";

const inside = (base: string, target: string) => {
  const rel = process.platform === "win32" ? win32.relative(base, target) : relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export class AccessController {
  readonly profile: AccessProfile;
  constructor(profile: AccessProfile = { mode: "full", network: true, integrations: true, backgroundJobs: true, externalActions: true }, private readonly parent?: AccessController, private readonly deniedCapabilities: Partial<Record<AccessCapability, boolean>> = {}) { this.profile = profile; }

  restrictCapabilities(denied: Partial<Record<AccessCapability, boolean>>): AccessController {
    return new AccessController({ mode: "full" }, this, denied);
  }

  async assertPath(path: string, operation: "read" | "write"): Promise<string> {
    const parentPath = await this.parent?.assertPath(path, operation);
    const absolute = resolve(parentPath ?? path);
    if (this.profile.mode === "full") return parentPath ?? absolute;
    const roots = (operation === "read" ? this.profile.readRoots : this.profile.writeRoots) ?? [];
    const resolveCanonical = async (candidate: string) => await realpath(candidate).catch(async () => {
      let parent = candidate;
      const suffix: string[] = [];
      while (true) {
        try { return resolve(await realpath(parent), ...suffix.reverse()); }
        catch { const next = resolve(parent, ".."); if (next === parent) return candidate; suffix.push(parent.slice(next.length + 1)); parent = next; }
      }
    });
    const canonicalTarget = await resolveCanonical(absolute);
    const allowed = await Promise.all(roots.map(async (root) => {
      const canonicalRoot = await realpath(resolve(root)).catch(() => resolve(root));
      return { canonicalRoot, allowed: inside(canonicalRoot, canonicalTarget) };
    }));
    const matchedRoot = allowed.find((candidate) => candidate.allowed);
    if (!matchedRoot) throw new Error(`Restricted profile denies ${operation} access to ${absolute}`);
    // Return the canonical target even when the link itself is under an allowed
    // root. Callers must operate on the path that passed the policy check.
    return canonicalTarget;
  }

  assertExecutable(command: string): void {
    this.parent?.assertExecutable(command);
    if (this.profile.mode === "full") return;
    const allow = this.profile.allowedExecutables ?? [];
    if (!allow.some((item) => item.toLowerCase() === command.toLowerCase())) throw new Error(`Restricted profile denies execution of ${command}`);
  }
  assertCapability(capability: AccessCapability): void {
    this.parent?.assertCapability(capability);
    if (this.deniedCapabilities[capability] === true) throw new Error(`Xyst settings deny ${capability} access`);
    if (this.profile.mode === "full") return;
    if (this.profile[capability] !== true) throw new Error(`Restricted profile denies ${capability}`);
  }
}
