import { MAX_IMAGE_COUNT } from '../core/limits.mjs';

const ALLOWED_FIELDS = new Set(['prompt', 'session_id', 'model', 'mode', 'worktree_id', 'images', 'mcp_servers']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Return the server's stable validation message, or null when the request shape is valid. */
export function validateControlApiRunRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key)))
    return 'Run body contains an unsupported property';
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 100_000)
    return 'prompt must contain 1 to 100000 characters';
  if (body.session_id !== undefined && (typeof body.session_id !== 'string' || !UUID_PATTERN.test(body.session_id)))
    return 'session_id must be a valid session UUID';
  if (body.mode !== undefined && !['agent', 'review', 'plan'].includes(body.mode)) return 'mode must be agent, review, or plan';
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200))
    return 'model must be a non-empty string of at most 200 characters';
  if (body.worktree_id !== undefined && (typeof body.worktree_id !== 'string' || !UUID_PATTERN.test(body.worktree_id)))
    return 'worktree_id must be a valid worktree UUID';
  if (
    body.mcp_servers !== undefined &&
    body.mcp_servers !== null &&
    (!Array.isArray(body.mcp_servers) ||
      body.mcp_servers.length > 16 ||
      body.mcp_servers.some((name) => typeof name !== 'string' || !MCP_SERVER_NAME_PATTERN.test(name)) ||
      new Set(body.mcp_servers).size !== body.mcp_servers.length)
  )
    return 'mcp_servers must be null or contain at most 16 unique configured server names';
  if (body.images !== undefined && (!Array.isArray(body.images) || body.images.length > MAX_IMAGE_COUNT))
    return `images must contain at most ${MAX_IMAGE_COUNT} attachments`;
  return null;
}
