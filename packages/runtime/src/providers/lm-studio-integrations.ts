import { z } from "zod";

const credentialReferenceSchema = z.object({ service: z.string().min(1).max(100), name: z.string().min(1).max(100) }).strict();
const allowedToolsSchema = z.array(z.string().min(1).max(200)).max(100).optional();
const pluginSchema = z.union([
  z.string().min(1).max(200).regex(/^mcp\/[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  z.object({ type: z.literal("plugin"), id: z.string().min(1).max(200).regex(/^mcp\/[A-Za-z0-9][A-Za-z0-9._/-]*$/), allowed_tools: allowedToolsSchema }).strict()
]);
const ephemeralSchema = z.object({
  type: z.literal("ephemeral_mcp"),
  server_label: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  server_url: z.string().url().max(2000).refine((value) => {
    try {
      const url = new URL(value);
      const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
      return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) && !url.username && !url.password && !url.hash;
    } catch { return false; }
  }, "MCP server URL must use HTTPS (HTTP is limited to loopback) and cannot contain credentials or a fragment"),
  allowed_tools: allowedToolsSchema,
  credential_headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/), credentialReferenceSchema).optional()
}).strict().superRefine((integration, context) => {
  const headerNames = Object.keys(integration.credential_headers ?? {}).map((header) => header.toLowerCase());
  if (new Set(headerNames).size !== headerNames.length) context.addIssue({ code: "custom", path: ["credential_headers"], message: "Credential header names must be unique ignoring case" });
});

export const lmStudioIntegrationsSchema = z.array(z.union([pluginSchema, ephemeralSchema])).max(16).superRefine((integrations, context) => {
  const seen = new Set<string>();
  for (const [index, integration] of integrations.entries()) {
    const id = typeof integration === "string" ? integration : integration.type === "plugin" ? integration.id : `ephemeral:${integration.server_label}`;
    if (seen.has(id)) context.addIssue({ code: "custom", path: [index], message: `Duplicate LM Studio integration: ${id}` });
    seen.add(id);
    if (typeof integration !== "string" && integration.type === "plugin" && integration.allowed_tools && new Set(integration.allowed_tools).size !== integration.allowed_tools.length) context.addIssue({ code: "custom", path: [index, "allowed_tools"], message: "Allowed tool names must be unique" });
    if (typeof integration !== "string" && integration.type === "ephemeral_mcp") {
      if (integration.allowed_tools && new Set(integration.allowed_tools).size !== integration.allowed_tools.length) context.addIssue({ code: "custom", path: [index, "allowed_tools"], message: "Allowed tool names must be unique" });
      if (integration.credential_headers && Object.keys(integration.credential_headers).length > 24) context.addIssue({ code: "custom", path: [index, "credential_headers"], message: "At most 24 credential headers are allowed per server" });
    }
  }
});

export type LMStudioIntegrationCredentialStore = { get(service: string, name: string): Promise<string | undefined> };
export type LMStudioNativeIntegration = z.infer<typeof pluginSchema> | Omit<z.infer<typeof ephemeralSchema>, "credential_headers"> & { headers?: Record<string, string> };

export async function resolveLMStudioIntegrations(raw: unknown, credentials: LMStudioIntegrationCredentialStore): Promise<{ integrations: LMStudioNativeIntegration[]; secrets: string[] }> {
  const parsed = lmStudioIntegrationsSchema.parse(raw);
  const integrations: LMStudioNativeIntegration[] = [];
  const secrets: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string" || entry.type === "plugin") { integrations.push(entry); continue; }
    const headers: Record<string, string> = {};
    for (const [header, reference] of Object.entries(entry.credential_headers ?? {})) {
      const value = await credentials.get(reference.service, reference.name);
      if (!value) throw new Error(`LM Studio MCP credential is missing: ${reference.service}/${reference.name}`);
      if (/[\r\n\0]/.test(value) || value.length > 8192) throw new Error(`LM Studio MCP credential for header ${header} is invalid or too long`);
      headers[header] = value;
      secrets.push(value);
    }
    const { credential_headers: _credentialHeaders, ...safeEntry } = entry;
    integrations.push({ ...safeEntry, ...(Object.keys(headers).length ? { headers } : {}) });
  }
  return { integrations, secrets };
}
