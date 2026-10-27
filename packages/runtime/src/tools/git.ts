import { runProcess, type ProcessOptions } from "../platform.js";
import type { AccessController } from "../access.js";
import { lstat, stat } from "node:fs/promises";
import { basename, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../credentials.js";
import { z } from "zod";

export class GitError extends Error {
  constructor(message: string, readonly code: number | null) { super(message); this.name = "GitError"; }
}

export async function git(args: string[], options: ProcessOptions & { cwd?: string } = {}): Promise<string> {
  const result = await runProcess("git", args, { ...options, maxOutputChars: options.maxOutputChars ?? 100_000 });
  if (result.code !== 0) throw new GitError(redactSecrets(result.stderr.trim()) || `git ${args[0]} failed with exit code ${result.code}`, result.code);
  return result.stdout.trimEnd();
}

async function repositoryRoot(access: AccessController, cwd: string, signal?: AbortSignal, operation: "read" | "write" = "read"): Promise<string> {
  access.assertExecutable("git"); await access.assertPath(cwd, operation);
  return git(["rev-parse", "--show-toplevel"], { cwd, ...(signal ? { signal } : {}) });
}

function validatePaths(paths: string[]): void {
  if (!paths.length || paths.length > 100) throw new Error("Specify between 1 and 100 repository-relative paths");
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    if (!path.trim() || isAbsolute(path) || /^[A-Za-z]:/.test(path) || normalized.split("/").some((part) => part === "..") || path.startsWith("-")) throw new Error(`Invalid repository-relative path: ${path}`);
  }
}

function validateBranchName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(name) || name.includes("..")) throw new Error("Invalid branch name");
}

export async function gitCreateBranch(access: AccessController, name: string, cwd = process.cwd(), signal?: AbortSignal): Promise<string> {
  access.assertCapability("externalActions"); access.assertExecutable("git");
  validateBranchName(name);
  const repo = await repositoryRoot(access, cwd, signal, "write");
  await git(["check-ref-format", "--branch", name], { cwd: repo, ...(signal ? { signal } : {}) });
  return git(["switch", "-c", name], { cwd: repo, ...(signal ? { signal } : {}) });
}

export async function gitStage(access: AccessController, paths: string[], cwd = process.cwd(), signal?: AbortSignal): Promise<{ staged: string[] }> {
  access.assertCapability("externalActions"); access.assertExecutable("git"); validatePaths(paths);
  const repo = await repositoryRoot(access, cwd, signal, "write");
  for (const path of paths) await access.assertPath(resolve(repo, path), "write");
  await git(["add", "--", ...paths], { cwd: repo, ...(signal ? { signal } : {}) });
  return { staged: paths };
}

export async function gitCommit(access: AccessController, message: string, paths: string[], cwd = process.cwd(), signal?: AbortSignal): Promise<{ commit: string; paths: string[] }> {
  access.assertCapability("externalActions"); access.assertExecutable("git"); validatePaths(paths);
  if (!message.trim() || message.length > 5000) throw new Error("Commit message must contain 1–5,000 characters");
  const repo = await repositoryRoot(access, cwd, signal, "write");
  for (const path of paths) await access.assertPath(resolve(repo, path), "write");
  await git(["commit", "--only", "-m", message, "--", ...paths], { cwd: repo, timeoutMs: 120_000, ...(signal ? { signal } : {}) });
  const commit = await git(["rev-parse", "HEAD"], { cwd: repo, ...(signal ? { signal } : {}) });
  return { commit, paths };
}

function validateRemote(remote: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(remote) || remote === "." || remote === "..") throw new Error("Invalid Git remote name");
}

function remoteHost(url: string): string {
  const ssh = url.match(/^[^@]+@([^:]+):/);
  return (ssh?.[1] ?? (() => { try { return new URL(url).hostname; } catch { return ""; } })()).toLowerCase();
}

function validateCloneUrl(value: string): { host: string; hostname: string; protocol: string; localPath?: string } {
  const scp = value.match(/^[^@]+@([^:]+):.+$/);
  if (scp) return { host: scp[1]!.toLowerCase(), hostname: scp[1]!.toLowerCase(), protocol: "ssh" };
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Git clone URL must be an HTTPS, SSH, or local file URL without embedded credentials"); }
  if (url.protocol === "file:") {
    if (url.hostname || url.username || url.password || url.search || url.hash) throw new Error("Local Git clone URLs cannot include a remote host, credentials, query, or fragment");
    return { host: "", hostname: "", protocol: "file:", localPath: fileURLToPath(url) };
  }
  if (!(["https:", "ssh:"].includes(url.protocol)) || (url.protocol === "https:" && url.username) || url.password || url.search || url.hash) throw new Error("Git clone URL must be an HTTPS or SSH URL without embedded credentials, query, or fragment");
  return { host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase(), protocol: url.protocol };
}

export function gitNetworkEnvironment(token?: string, base: NodeJS.ProcessEnv = process.env, host = "github.com"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0" };
  if (!token) return env;
  const configuredCount = env.GIT_CONFIG_COUNT === undefined || env.GIT_CONFIG_COUNT === "" ? 0 : Number(env.GIT_CONFIG_COUNT);
  if (!Number.isSafeInteger(configuredCount) || configuredCount < 0 || configuredCount >= 100) throw new Error("Git environment contains an invalid or excessive GIT_CONFIG_COUNT");
  const count = configuredCount;
  env.GIT_CONFIG_COUNT = String(count + 1);
  if (!/^(?:[a-z0-9.-]+)(?::[0-9]{1,5})?$/.test(host) || host.includes("..")) throw new Error("Invalid GitHub credential host");
  env[`GIT_CONFIG_KEY_${count}`] = `http.https://${host}/.extraheader`;
  env[`GIT_CONFIG_VALUE_${count}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return env;
}

type GitHubGitOptions = { enabled: boolean; writesEnabled?: boolean; enterpriseHost?: string; token?: (signal?: AbortSignal) => Promise<string | undefined> };
function isGitHubHost(host: string, enterpriseHost?: string): boolean { return host === "github.com" || Boolean(enterpriseHost && host === enterpriseHost.toLowerCase()); }
async function remoteUrl(repo: string, remote: string, signal?: AbortSignal): Promise<string> { return git(["remote", "get-url", remote], { cwd: repo, ...(signal ? { signal } : {}) }); }
function remoteMatchesGitHub(url: string, enterpriseHost?: string): boolean { return isGitHubHost(remoteHost(url), enterpriseHost); }
function remoteCredentialHost(url: string): string { try { return new URL(url).host.toLowerCase(); } catch { return remoteHost(url); } }

export async function gitClone(access: AccessController, url: string, destination: string, cwd = process.cwd(), signal?: AbortSignal, github: GitHubGitOptions = { enabled: false }): Promise<{ path: string; output: string }> {
  access.assertCapability("externalActions"); access.assertExecutable("git");
  if (url.length > 2000) throw new Error("Git clone URL is too long");
  const remote = validateCloneUrl(url);
  if (remote.protocol !== "file:") access.assertCapability("network");
  if (remote.localPath) await access.assertPath(remote.localPath, "read");
  const githubRemote = remote.protocol !== "file:" && isGitHubHost(remote.hostname, github.enterpriseHost);
  if (githubRemote) {
    access.assertCapability("integrations");
    if (!github.enabled) throw new Error("GitHub clone requires integrations.github.enabled");
  }
  const target = resolve(cwd, destination); const parent = dirname(target);
  await access.assertPath(parent, "write");
  if (!(await stat(parent).catch(() => undefined))?.isDirectory()) throw new Error("Git clone destination parent must be an existing directory");
  await access.assertPath(target, "write");
  if (await lstat(target).then(() => true, () => false)) throw new Error("Git clone destination already exists");
  const token = githubRemote && remote.protocol === "https:" ? await github.token?.(signal) : undefined;
  const env = gitNetworkEnvironment(token, process.env, remote.host || "github.com");
  const output = await git(["clone", "--", url, basename(target)], { cwd: parent, timeoutMs: 300_000, env, ...(signal ? { signal } : {}) });
  return { path: target, output };
}

export async function gitFetch(access: AccessController, remote = "origin", ref?: string, cwd = process.cwd(), signal?: AbortSignal, github: GitHubGitOptions = { enabled: false }): Promise<string> {
  access.assertCapability("network"); access.assertCapability("externalActions"); access.assertExecutable("git"); validateRemote(remote);
  const repo = await repositoryRoot(access, cwd, signal, "write");
  const url = await remoteUrl(repo, remote, signal);
  if (remoteMatchesGitHub(url, github.enterpriseHost)) {
    access.assertCapability("integrations");
    if (!github.enabled) throw new Error("GitHub fetch requires integrations.github.enabled");
    const token = await github.token?.(signal);
    const env = gitNetworkEnvironment(token, process.env, remoteCredentialHost(url));
    if (ref) {
      validateBranchName(ref);
      await git(["check-ref-format", "--branch", ref], { cwd: repo, ...(signal ? { signal } : {}) });
      return git(["fetch", remote, `refs/heads/${ref}:refs/remotes/${remote}/${ref}`], { cwd: repo, timeoutMs: 120_000, env, ...(signal ? { signal } : {}) });
    }
    return git(["fetch", remote], { cwd: repo, timeoutMs: 120_000, env, ...(signal ? { signal } : {}) });
  }
  const env = gitNetworkEnvironment();
  if (ref) {
    validateBranchName(ref);
    await git(["check-ref-format", "--branch", ref], { cwd: repo, ...(signal ? { signal } : {}) });
    return git(["fetch", remote, `refs/heads/${ref}:refs/remotes/${remote}/${ref}`], { cwd: repo, timeoutMs: 120_000, env, ...(signal ? { signal } : {}) });
  }
  return git(["fetch", remote], { cwd: repo, timeoutMs: 120_000, env, ...(signal ? { signal } : {}) });
}

export async function gitPush(access: AccessController, remote = "origin", branch?: string, cwd = process.cwd(), signal?: AbortSignal, github: GitHubGitOptions = { enabled: false, writesEnabled: false }): Promise<string> {
  access.assertCapability("network"); access.assertCapability("externalActions"); access.assertExecutable("git"); validateRemote(remote);
  const repo = await repositoryRoot(access, cwd, signal, "write");
  let env: NodeJS.ProcessEnv;
  const url = await remoteUrl(repo, remote, signal);
  if (remoteMatchesGitHub(url, github.enterpriseHost)) {
    access.assertCapability("integrations");
    if (!github.enabled || !github.writesEnabled) throw new Error("GitHub push requires integrations.github.enabled and integrations.github.writeEnabled");
    env = gitNetworkEnvironment(await github.token?.(signal), process.env, remoteCredentialHost(url));
  } else {
    env = gitNetworkEnvironment();
  }
  const target = branch ?? await git(["branch", "--show-current"], { cwd: repo, ...(signal ? { signal } : {}) });
  if (!target) throw new Error("Push requires a valid named branch; detached HEAD is not supported");
  validateBranchName(target);
  await git(["check-ref-format", "--branch", target], { cwd: repo, ...(signal ? { signal } : {}) });
  return git(["push", "--porcelain", remote, `HEAD:refs/heads/${target}`], { cwd: repo, timeoutMs: 120_000, env, ...(signal ? { signal } : {}) });
}

export async function gitStatus(access: AccessController, cwd = process.cwd(), signal?: AbortSignal): Promise<string> {
  const repo = await repositoryRoot(access, cwd, signal); return git(["status", "--short", "--branch"], { cwd: repo, ...(signal ? { signal } : {}) });
}
export async function gitDiff(access: AccessController, cwd = process.cwd(), staged = false, signal?: AbortSignal): Promise<string> {
  const repo = await repositoryRoot(access, cwd, signal); return git(["diff", ...(staged ? ["--cached"] : []), "--"], { cwd: repo, maxOutputChars: 100_000, ...(signal ? { signal } : {}) });
}
export async function gitLog(access: AccessController, cwd = process.cwd(), limit = 20, signal?: AbortSignal): Promise<string> {
  const repo = await repositoryRoot(access, cwd, signal); return git(["log", `-${Math.max(1, Math.min(100, limit))}`, "--date=short", "--format=%h %ad %s"], { cwd: repo, ...(signal ? { signal } : {}) });
}
export async function gitBranches(access: AccessController, cwd = process.cwd(), signal?: AbortSignal): Promise<string> {
  const repo = await repositoryRoot(access, cwd, signal); return git(["branch", "--all", "--no-color"], { cwd: repo, ...(signal ? { signal } : {}) });
}

export function createGitTools(access: AccessController, workspace = process.cwd(), options: { githubEnabled?: boolean; githubWritesEnabled?: boolean; githubEnterpriseHost?: string; githubToken?: (signal?: AbortSignal) => Promise<string | undefined> } = {}): Record<string, { definition: Record<string, unknown>; execute(input: unknown, signal?: AbortSignal): Promise<unknown> }> {
  const stringSchema = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } });
  const root = async (cwd?: string, signal?: AbortSignal, operation: "read" | "write" = "read") => await repositoryRoot(access, cwd ?? workspace, signal, operation);
  const pathsSchema = z.array(z.string().min(1).max(2000)).min(1).max(100);
  return {
    git_clone: { definition: stringSchema("git_clone", "Clone an HTTPS, SSH, or local file Git repository into a new destination. GitHub remotes require GitHub integration access and use the configured Xyst GitHub token for HTTPS.", { url: { type: "string" }, destination: { type: "string" }, cwd: { type: "string" } }, ["url", "destination"]), execute: async (input, signal) => { const args = z.object({ url: z.string().min(1).max(2000), destination: z.string().min(1).max(2000), cwd: z.string().optional() }).strict().parse(input); return gitClone(access, args.url, args.destination, args.cwd ?? workspace, signal, { enabled: options.githubEnabled === true, ...(options.githubEnterpriseHost ? { enterpriseHost: options.githubEnterpriseHost } : {}), ...(options.githubToken ? { token: options.githubToken } : {}) }); } },
    git_status: { definition: stringSchema("git_status", "Show the current Git branch and changed files.", {}, []), execute: async (input, signal) => { z.object({}).strict().parse(input); return gitStatus(access, await root(undefined, signal), signal); } },
    git_diff: { definition: stringSchema("git_diff", "Show current Git changes. Set staged to true to show staged changes.", { staged: { type: "boolean" }, cwd: { type: "string" } }, []), execute: async (input, signal) => { const args = z.object({ staged: z.boolean().optional(), cwd: z.string().optional() }).strict().parse(input); return gitDiff(access, await root(args.cwd, signal), args.staged ?? false, signal); } },
    git_log: { definition: stringSchema("git_log", "Show recent Git commits.", { limit: { type: "integer", minimum: 1, maximum: 100 }, cwd: { type: "string" } }, []), execute: async (input, signal) => { const args = z.object({ limit: z.number().int().min(1).max(100).optional(), cwd: z.string().optional() }).strict().parse(input); return gitLog(access, await root(args.cwd, signal), args.limit ?? 20, signal); } },
    git_branches: { definition: stringSchema("git_branches", "List local and remote Git branches.", { cwd: { type: "string" } }, []), execute: async (input, signal) => { const args = z.object({ cwd: z.string().optional() }).strict().parse(input); return gitBranches(access, await root(args.cwd, signal), signal); } },
    git_create_branch: { definition: stringSchema("git_create_branch", "Create and switch to a new Git branch. Use only when the objective requests a branch or GitHub workflow.", { name: { type: "string" }, cwd: { type: "string" } }, ["name"]), execute: async (input, signal) => { const args = z.object({ name: z.string().min(1).max(120), cwd: z.string().optional() }).strict().parse(input); return gitCreateBranch(access, args.name, args.cwd ?? workspace, signal); } },
    git_stage: { definition: stringSchema("git_stage", "Stage only the explicitly listed repository-relative paths for a requested Git change.", { paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 }, cwd: { type: "string" } }, ["paths"]), execute: async (input, signal) => { const args = z.object({ paths: pathsSchema, cwd: z.string().optional() }).strict().parse(input); return gitStage(access, args.paths, args.cwd ?? workspace, signal); } },
    git_commit: { definition: stringSchema("git_commit", "Commit only the explicitly listed paths; unrelated staged changes are left out. Stage new files first.", { message: { type: "string" }, paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 }, cwd: { type: "string" } }, ["message", "paths"]), execute: async (input, signal) => { const args = z.object({ message: z.string().min(1).max(5000), paths: pathsSchema, cwd: z.string().optional() }).strict().parse(input); return gitCommit(access, args.message, args.paths, args.cwd ?? workspace, signal); } },
    git_fetch: { definition: stringSchema("git_fetch", "Fetch a branch or configured remote without merging or rebasing. Requires network and external-action permission; GitHub remotes also require the GitHub setting.", { remote: { type: "string" }, branch: { type: "string" }, cwd: { type: "string" } }, []), execute: async (input, signal) => { const args = z.object({ remote: z.string().optional(), branch: z.string().min(1).max(255).optional(), cwd: z.string().optional() }).strict().parse(input); return gitFetch(access, args.remote, args.branch, args.cwd ?? workspace, signal, { enabled: options.githubEnabled === true, ...(options.githubEnterpriseHost ? { enterpriseHost: options.githubEnterpriseHost } : {}), ...(options.githubToken ? { token: options.githubToken } : {}) }); } },
    git_push: { definition: stringSchema("git_push", "Push the current HEAD to an explicitly authorized branch on a configured remote. GitHub pushes require GitHub and write settings. Never force-push.", { remote: { type: "string" }, branch: { type: "string" }, cwd: { type: "string" } }, []), execute: async (input, signal) => { const args = z.object({ remote: z.string().optional(), branch: z.string().min(1).max(255).optional(), cwd: z.string().optional() }).strict().parse(input); return gitPush(access, args.remote, args.branch, args.cwd ?? workspace, signal, { enabled: options.githubEnabled === true, writesEnabled: options.githubWritesEnabled === true, ...(options.githubEnterpriseHost ? { enterpriseHost: options.githubEnterpriseHost } : {}), ...(options.githubToken ? { token: options.githubToken } : {}) }); } }
  };
}
