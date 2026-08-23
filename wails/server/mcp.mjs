// ─────────────────────────────────────────────────────────────────────────
// Hosted MCP (Model Context Protocol) server for BTCT.
//
// Exposes the workspace to an external MCP client (e.g. Claude Code CLI) over
// Streamable HTTP at POST /mcp. Reuses the in-app assistant's tool catalog and
// `dispatch()` router (server/ai.mjs) over the live shared Yjs doc, so the MCP
// tools stay in sync with the assistant. Read tools are always available; write
// tools appear only when an admin sets MCP mode to "edit".
//
// Auth is a static bearer token stored in the SQLite `settings` KV (admin-
// generated), checked here at the HTTP layer — the MCP transport does no auth.
// ─────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getSetting, setSetting } from './db.mjs';
import { READ_TOOLS, WRITE_TOOLS, dispatch } from './ai.mjs';
import { listWorkspaces } from './yjs-data.mjs';

const T_ENABLED = 'mcp_enabled';
const T_TOKEN = 'mcp_token';
const T_MODE = 'mcp_mode';
const VERSION = '1.0.0';

const genToken = () => crypto.randomBytes(32).toString('hex');

// ── Admin config (stored in settings; token IS returned to admins so it can be
//    pasted into the client — it grants access, so treat it like a password) ──
export function getMcpConfig() {
  return {
    enabled: getSetting(T_ENABLED) === '1',
    mode: getSetting(T_MODE) === 'edit' ? 'edit' : 'read',
    configured: !!getSetting(T_TOKEN),
    token: getSetting(T_TOKEN) || null,
  };
}

export function setMcpConfig(body) {
  if (typeof body.enabled === 'boolean') {
    setSetting(T_ENABLED, body.enabled ? '1' : '0');
    if (body.enabled && !getSetting(T_TOKEN)) setSetting(T_TOKEN, genToken()); // mint on first enable
  }
  if (body.mode !== undefined) {
    if (body.mode !== 'read' && body.mode !== 'edit') throw new Error('mode must be "read" or "edit"');
    setSetting(T_MODE, body.mode);
  }
  return getMcpConfig();
}

export function regenerateMcpToken() {
  const t = genToken();
  setSetting(T_TOKEN, t);
  return t;
}

// ── JSON-Schema (Anthropic tool format) → raw zod shape ──
// Covers the small subset the tool defs use so we can register the exact
// READ_TOOLS/WRITE_TOOLS from ai.mjs without hand-duplicating schemas.
function propToZod(p) {
  if (Array.isArray(p.enum)) return z.enum(p.enum);
  switch (p.type) {
    case 'string': return z.string();
    case 'number':
    case 'integer': return z.number();
    case 'boolean': return z.boolean();
    case 'array': return z.array(p.items && p.items.type === 'string' ? z.string() : z.any());
    case 'object': return z.object({}).passthrough();
    default: return z.any();
  }
}
// Memoized by schema identity: the tool defs are module constants, so every
// request built the same ~100 zod objects from scratch. The shapes are
// immutable, so cache them keyed on the input_schema object.
const zodShapeCache = new WeakMap();
function toZodShape(inputSchema) {
  if (inputSchema && typeof inputSchema === 'object') {
    const hit = zodShapeCache.get(inputSchema);
    if (hit) return hit;
  }
  const shape = {};
  const props = inputSchema?.properties || {};
  const required = new Set(inputSchema?.required || []);
  for (const [key, p] of Object.entries(props)) {
    let zt = propToZod(p);
    if (p.description) zt = zt.describe(p.description);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  if (inputSchema && typeof inputSchema === 'object') zodShapeCache.set(inputSchema, shape);
  return shape;
}

const WRITE_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

function buildServer(mode) {
  const server = new McpServer({ name: 'btct', version: VERSION });
  const tools = mode === 'edit' ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  const actor = { userId: null, userName: 'MCP', userColor: '#6b7280' };
  for (const t of tools) {
    const isWrite = WRITE_NAMES.has(t.name);
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: toZodShape(t.input_schema) },
      async (args) => {
        try {
          const input = args || {};
          // Reads default to ALL workspaces (workspaceId null); writes that need
          // a workspace default to the first one so created entities land valid.
          let workspaceId = input.workspaceId ?? null;
          if (!workspaceId && isWrite) {
            const wss = await listWorkspaces();
            workspaceId = wss[0]?.id ?? null;
          }
          const out = await dispatch(t.name, input, { mode, workspaceId, actor });
          return { content: [{ type: 'text', text: JSON.stringify(out ?? null, null, 2) }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${String(e?.message || e)}` }], isError: true };
        }
      },
    );
  }
  return server;
}

// ── HTTP handler for /mcp ──
function rpcError(res, status, code, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function constantEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export async function handleMcp(req, res) {
  const token = getSetting(T_TOKEN);
  if (getSetting(T_ENABLED) !== '1' || !token) return rpcError(res, 401, -32001, 'MCP disabled');

  const h = req.headers.authorization || '';
  const provided = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  if (!provided || !constantEq(provided, token)) return rpcError(res, 401, -32001, 'Unauthorized');

  // Stateless: GET (SSE) / DELETE (session teardown) aren't needed.
  if (req.method !== 'POST') return rpcError(res, 405, -32000, 'Method not allowed.');

  const server = buildServer(getMcpConfig().mode);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    // Cap the body and concat as buffers (string += could split a multi-byte
    // UTF-8 sequence across a chunk boundary and corrupt the JSON).
    const MAX_MCP_BODY = 4 * 1024 * 1024;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_MCP_BODY) return rpcError(res, 413, -32000, 'Request body too large');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsedBody = raw.length ? JSON.parse(raw) : undefined;
    // The transport owns `res` from here (writes status/headers/SSE) — do not
    // send any headers before this point.
    await transport.handleRequest(req, res, parsedBody);
    res.on('close', () => {
      try { transport.close(); } catch { /* ignore */ }
      try { server.close(); } catch { /* ignore */ }
    });
  } catch (e) {
    if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error');
  }
}
