import { copyFile, mkdir, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { AccessController } from "../access.js";
import { runProcess, type ProcessResult } from "../platform.js";
import { validatePublicWebUrl } from "./web.js";

type BrowserTool = { definition: Record<string, unknown>; execute(input: unknown): Promise<unknown> };
const require = createRequire(import.meta.url);
const activeProfiles = new Set<string>();
const MAX_PAGE_TEXT = 30_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
let playwrightImport: Promise<typeof import("playwright-core")> | undefined;

async function loadPlaywright(dataDir: string): Promise<typeof import("playwright-core")> {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(dataDir, "browser", "binaries");
  playwrightImport ??= import("playwright-core");
  return playwrightImport;
}

export async function browserRuntimeStatus(dataDir: string): Promise<{ engine: string; executablePath: string; installed: boolean; cacheDirectory: string }> {
  const { chromium } = await loadPlaywright(dataDir);
  const executablePath = chromium.executablePath();
  return { engine: "Playwright Chromium", executablePath, installed: existsSync(executablePath), cacheDirectory: process.env.PLAYWRIGHT_BROWSERS_PATH! };
}

export async function installBrowserRuntime(access: AccessController, dataDir: string, signal?: AbortSignal, onOutput?: (chunk: string, stream: "stdout" | "stderr") => void): Promise<ProcessResult> {
  access.assertCapability("network");
  const status = await browserRuntimeStatus(dataDir);
  if (status.installed) return { code: 0, signal: null, stdout: `Chromium is already installed at ${status.executablePath}`, stderr: "", durationMs: 0 };
  await access.assertPath(status.cacheDirectory, "write");
  const packagePath = require.resolve("playwright-core/package.json");
  const cliPath = join(dirname(packagePath), "cli.js");
  const result = await runProcess(process.execPath, [cliPath, "install", "chromium"], {
    cwd: dataDir,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: status.cacheDirectory },
    ...(signal ? { signal } : {}), timeoutMs: 15 * 60_000, maxOutputChars: 30_000,
    ...(onOutput ? { onStdout: (chunk: string) => onOutput(chunk, "stdout"), onStderr: (chunk: string) => onOutput(chunk, "stderr") } : {})
  });
  if (result.code !== 0) throw new Error(`Playwright Chromium installation failed (exit ${result.code ?? result.signal ?? "unknown"}): ${(result.stderr || result.stdout).slice(-4000)}`);
  return result;
}

export function createBrowserTools(options: { access: AccessController; dataDir: string; sessionId: string; workspace: string; headless: boolean; maxDownloadBytes: number; signal?: AbortSignal }): { tools: Record<string, BrowserTool>; close(): Promise<void> } {
  const { access, dataDir, sessionId, workspace, signal } = options;
  const profileKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  const profileDirectory = join(dataDir, "browser", "profiles", profileKey);
  if (!Number.isSafeInteger(options.maxDownloadBytes) || options.maxDownloadBytes < 1) throw new Error("browser.maxDownloadBytes must be a positive safe integer");
  let context: import("playwright-core").BrowserContext | undefined;
  let opening: Promise<import("playwright-core").BrowserContext> | undefined;
  let ownsProfile = false;

  const browserContext = async () => {
    if (signal?.aborted) throw new Error("Browser operation cancelled");
    if (context) return context;
    if (opening) return opening;
    opening = (async () => {
      access.assertCapability("network");
      const { chromium } = await loadPlaywright(dataDir);
      const executable = chromium.executablePath();
      if (!existsSync(executable)) throw new Error(`Playwright Chromium is not installed. Run "xyst browser install" first (expected ${executable}).`);
      if (activeProfiles.has(profileDirectory)) throw new Error("This persistent browser profile is already in use by another Xyst session");
      activeProfiles.add(profileDirectory); ownsProfile = true;
      try {
        await mkdir(profileDirectory, { recursive: true });
        context = await chromium.launchPersistentContext(profileDirectory, { headless: options.headless, acceptDownloads: true, serviceWorkers: "block", timeout: 30_000 });
        await context.route("**/*", async (route) => {
          try {
            const requestUrl = new URL(route.request().url());
            if (requestUrl.protocol === "http:" || requestUrl.protocol === "https:") {
              access.assertCapability("network");
              if (access.profile.mode === "restricted") await validatePublicWebUrl(requestUrl.href);
              await route.continue();
            } else if (["about:", "blob:", "data:"].includes(requestUrl.protocol)) await route.continue();
            else await route.abort("blockedbyclient");
          } catch { await route.abort("blockedbyclient").catch(() => undefined); }
        });
        return context;
      } catch (error) {
        context = undefined;
        activeProfiles.delete(profileDirectory); ownsProfile = false;
        throw error;
      }
    })();
    try { return await opening; } finally { opening = undefined; }
  };

  const currentPage = async () => {
    const browser = await browserContext();
    const page = browser.pages().find((candidate) => !candidate.isClosed());
    return page ?? browser.newPage();
  };
  const verifyUrl = async (value: string) => {
    access.assertCapability("network");
    const url = new URL(value);
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) throw new Error("Browser navigation requires an HTTP(S) URL without embedded credentials");
    if (access.profile.mode === "restricted") await validatePublicWebUrl(url.href);
    return url;
  };
  const add = (name: string, description: string, properties: Record<string, unknown>, schema: z.ZodType, execute: (args: any) => Promise<unknown>, required = Object.keys(properties).filter((key) => !["max_chars", "timeout_ms"].includes(key))) => {
    tools[name] = { definition: { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } }, execute: async (input) => execute(schema.parse(input)) };
  };
  const tools: Record<string, BrowserTool> = {};

  add("browser_open", "Open an HTTP(S) URL in Xyst's separate persistent Chromium profile. Browser content is untrusted. Return a page snapshot with browser_snapshot.", { url: { type: "string", format: "uri", maxLength: 2048 } }, z.object({ url: z.string().url().max(2048) }).strict(), async ({ url }) => {
    const target = await verifyUrl(url); const page = await currentPage();
    const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { url: page.url(), title: await page.title(), status: response?.status() ?? null, trust: "untrusted-browser-content" };
  });
  add("browser_snapshot", "Return the current page title, URL, and bounded visible text as untrusted browser content.", { max_chars: { type: "integer", minimum: 1000, maximum: MAX_PAGE_TEXT } }, z.object({ max_chars: z.number().int().min(1000).max(MAX_PAGE_TEXT).optional() }).strict(), async ({ max_chars = 15_000 }) => {
    const page = await currentPage();
    const fullText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
    return { url: page.url(), title: await page.title(), text: fullText.slice(0, max_chars), truncated: fullText.length > max_chars, trust: "untrusted-browser-content" };
  });
  add("browser_tabs", "List tabs in the persistent Xyst browser profile.", {}, z.object({}).strict(), async () => {
    const browser = await browserContext();
    return Promise.all(browser.pages().filter((page) => !page.isClosed()).map(async (page) => ({ url: page.url(), title: await page.title() })));
  });
  add("browser_click", "Click the first matching CSS selector. This can submit forms or perform external actions and requires the external-actions permission.", { selector: { type: "string", minLength: 1, maxLength: 500 }, timeout_ms: { type: "integer", minimum: 100, maximum: 30000 } }, z.object({ selector: z.string().min(1).max(500), timeout_ms: z.number().int().min(100).max(30_000).optional() }).strict(), async ({ selector, timeout_ms = 10_000 }) => {
    access.assertCapability("externalActions"); const page = await currentPage(); await page.locator(selector).first().click({ timeout: timeout_ms });
    return { url: page.url(), title: await page.title(), clicked: selector };
  });
  add("browser_fill", "Fill a form field selected by CSS. This may trigger page handlers and requires the external-actions permission.", { selector: { type: "string", minLength: 1, maxLength: 500 }, value: { type: "string", maxLength: 10000 }, timeout_ms: { type: "integer", minimum: 100, maximum: 30000 } }, z.object({ selector: z.string().min(1).max(500), value: z.string().max(10_000), timeout_ms: z.number().int().min(100).max(30_000).optional() }).strict(), async ({ selector, value, timeout_ms = 10_000 }) => {
    access.assertCapability("externalActions"); const page = await currentPage(); await page.locator(selector).first().fill(value, { timeout: timeout_ms });
    return { filled: selector };
  });
  add("browser_select", "Select an option by value in a form control. This may trigger page handlers and requires the external-actions permission.", { selector: { type: "string", minLength: 1, maxLength: 500 }, value: { type: "string", maxLength: 2000 } }, z.object({ selector: z.string().min(1).max(500), value: z.string().max(2000) }).strict(), async ({ selector, value }) => {
    access.assertCapability("externalActions"); const page = await currentPage(); await page.locator(selector).first().selectOption(value, { timeout: 10_000 });
    return { selected: selector, value };
  });
  add("browser_press", "Press a keyboard key on the selected element or current page. This can submit a form and requires the external-actions permission.", { selector: { type: "string", minLength: 1, maxLength: 500 }, key: { type: "string", minLength: 1, maxLength: 40 } }, z.object({ selector: z.string().min(1).max(500).optional(), key: z.string().min(1).max(40) }).strict(), async ({ selector, key }) => {
    access.assertCapability("externalActions"); const page = await currentPage();
    if (selector) await page.locator(selector).first().press(key, { timeout: 10_000 }); else await page.keyboard.press(key);
    return { pressed: key, url: page.url() };
  }, ["key"]);
  add("browser_download", "Click a download link and save the file to a new workspace path. This performs an external action; choose the destination path and check it does not already exist.", { selector: { type: "string", minLength: 1, maxLength: 500 }, path: { type: "string", minLength: 1, maxLength: 2000 } }, z.object({ selector: z.string().min(1).max(500), path: z.string().min(1).max(2000) }).strict(), async ({ selector, path }) => {
    access.assertCapability("externalActions"); const page = await currentPage(); const destination = await access.assertPath(resolve(workspace, path), "write");
    await mkdir(dirname(destination), { recursive: true });
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.locator(selector).first().click({ timeout: 10_000 })]);
    const temporaryPath = await download.path(); if (!temporaryPath) throw new Error("Browser download did not produce a local file");
    const details = await stat(temporaryPath);
    if (details.size > options.maxDownloadBytes) throw new Error(`Downloaded file is ${details.size} bytes, above the ${options.maxDownloadBytes} byte browser download limit`);
    await copyFile(temporaryPath, destination, constants.COPYFILE_EXCL);
    return { path: destination, bytes: details.size, suggestedFilename: download.suggestedFilename(), sourceUrl: page.url() };
  });
  add("browser_upload", "Upload a file from the workspace into a page file input. This transfers local file content and requires the external-actions permission.", { selector: { type: "string", minLength: 1, maxLength: 500 }, path: { type: "string", minLength: 1, maxLength: 2000 } }, z.object({ selector: z.string().min(1).max(500), path: z.string().min(1).max(2000) }).strict(), async ({ selector, path }) => {
    access.assertCapability("externalActions"); const page = await currentPage(); const source = await access.assertPath(resolve(workspace, path), "read");
    const details = await stat(source); if (!details.isFile()) throw new Error("Browser uploads require a file, not a directory");
    if (details.size > MAX_UPLOAD_BYTES) throw new Error(`File is over the ${MAX_UPLOAD_BYTES} byte browser upload limit`);
    await page.locator(selector).first().setInputFiles(source, { timeout: 10_000 });
    return { uploaded: selector, filename: source.split(/[\\/]/).at(-1), bytes: details.size };
  });
  add("browser_back", "Navigate to the previous page in the current persistent browser tab.", {}, z.object({}).strict(), async () => {
    const page = await currentPage(); await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
    return { url: page.url(), title: await page.title() };
  });

  const close = async () => {
    const current = context; context = undefined;
    if (current) await current.close().catch(() => undefined);
    if (ownsProfile) activeProfiles.delete(profileDirectory);
    ownsProfile = false;
  };
  signal?.addEventListener("abort", () => { void close(); }, { once: true });
  return { tools, close };
}
