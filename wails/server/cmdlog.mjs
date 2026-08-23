// ─────────────────────────────────────────────────────────────────────────
// Team command log — ingest + config for the btct-cmdlog agent.
//
// Each operator runs a small Python agent (see ../cmdlog-agent) on their Kali
// box that captures whitelisted pentest commands from their shell and POSTs
// them here. Events land in two places:
//   • SQLite `command_logs` (db.mjs) — the durable, unbounded archive.
//   • the shared Yjs doc `commandLogs` map (yjs-data.mjs) — a bounded live
//     window so every open browser sees new commands push in with no polling.
//
// This is the THIRD deliberate exception to "the server is dumb about domain
// data" (alongside the AI assistant and assets.mjs): the ingest endpoint writes
// workspace content. It stays as dumb as possible — it validates/clamps and
// stores, and knows nothing about what a command means.
//
// Auth mirrors mcp.mjs: a static bearer ingest token in the settings KV,
// admin-generated, checked with a timing-safe compare, gated behind an enabled
// flag. Operator identity is self-asserted (the --operator arg) — appropriate
// for a trusted competition team, not for adversarial auditing.
// ─────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { getSetting, setSetting, upsertCommandLog, upsertCommandLogBatch, queryCommandLogs, clearCommandLogs } from './db.mjs';
import { appendCommandLogs, listWorkspaces } from './yjs-data.mjs';

const T_ENABLED = 'cmdlog_enabled';
const T_TOKEN = 'cmdlog_token';
const T_WHITELIST = 'cmdlog_whitelist';   // JSON array of tool names
const T_WORKSPACE = 'cmdlog_workspace';   // default target workspace id

const MAX_BATCH = 200;
const MAX_CMD_LEN = 4096;
const MAX_FIELD_LEN = 512;

const genToken = () => 'btct_ing_' + crypto.randomBytes(24).toString('hex');

// Sensible default pentest toolset. Admins can override the list in the UI;
// the agent fetches whichever list is stored (or this default if unset).
export const DEFAULT_WHITELIST = [
  'nmap', 'masscan', 'rustscan', 'gobuster', 'feroxbuster', 'ffuf', 'dirb', 'dirbuster',
  'nikto', 'whatweb', 'wpscan', 'hydra', 'medusa', 'ncrack', 'sqlmap', 'crackmapexec',
  'nxc', 'netexec', 'evil-winrm', 'responder', 'bloodhound-python', 'enum4linux',
  'enum4linux-ng', 'smbclient', 'smbmap', 'rpcclient', 'ldapsearch', 'kerbrute',
  'impacket-secretsdump', 'impacket-psexec', 'impacket-wmiexec', 'impacket-GetUserSPNs',
  'impacket-GetNPUsers', 'secretsdump.py', 'psexec.py', 'wmiexec.py', 'GetUserSPNs.py',
  'GetNPUsers.py', 'hashcat', 'john', 'msfconsole', 'msfvenom', 'searchsploit', 'curl',
  'wget', 'ssh', 'nc', 'ncat', 'netcat', 'socat', 'proxychains', 'proxychains4', 'ping',
];

// ── Admin config ──
// The token IS returned to admins (like MCP) so it can be copied into the agent
// invocation. It grants ingest — treat it like a password.
export function getCmdlogConfig() {
  return {
    enabled: getSetting(T_ENABLED) === '1',
    configured: !!getSetting(T_TOKEN),
    token: getSetting(T_TOKEN) || null,
    whitelist: getWhitelist(),
    workspaceId: getSetting(T_WORKSPACE) || null,
  };
}

export function setCmdlogConfig(body) {
  if (typeof body.enabled === 'boolean') {
    setSetting(T_ENABLED, body.enabled ? '1' : '0');
    if (body.enabled && !getSetting(T_TOKEN)) setSetting(T_TOKEN, genToken()); // mint on first enable
  }
  if (body.whitelist !== undefined) {
    if (!Array.isArray(body.whitelist)) throw new Error('whitelist must be an array of tool names');
    const tools = [...new Set(
      body.whitelist
        .map((t) => String(t || '').trim().toLowerCase())
        .filter((t) => t && t.length <= 64 && !/\s/.test(t)),
    )];
    setSetting(T_WHITELIST, JSON.stringify(tools));
  }
  if (body.workspaceId !== undefined) {
    setSetting(T_WORKSPACE, body.workspaceId ? String(body.workspaceId) : '');
  }
  return getCmdlogConfig();
}

export function regenerateCmdlogToken() {
  const t = genToken();
  setSetting(T_TOKEN, t);
  return t;
}

export function getWhitelist() {
  const raw = getSetting(T_WHITELIST);
  if (!raw) return DEFAULT_WHITELIST;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_WHITELIST;
  } catch {
    return DEFAULT_WHITELIST;
  }
}

// ── Bearer gate (identical shape to mcp.mjs) ──
function constantEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Returns true if the request carries a valid ingest token AND cmdlog is
// enabled; otherwise writes a 401 and returns false. Enabled is checked before
// the token so a disabled integration is closed even if a token still exists.
function requireIngest(req, res, sendJson) {
  const token = getSetting(T_TOKEN);
  if (getSetting(T_ENABLED) !== '1' || !token) {
    sendJson(res, 401, { error: 'command log ingest disabled' });
    return false;
  }
  const h = req.headers.authorization || '';
  const provided = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  if (!provided || !constantEq(provided, token)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

// ── Field coercion ──
const clampStr = (v, max = MAX_FIELD_LEN) =>
  (v === undefined || v === null) ? null : String(v).slice(0, max);
const clampInt = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);

// Normalize one raw agent event into a storable record, or null if it's missing
// required fields. `workspaceId` is resolved by the caller (batch-level).
function normalizeEvent(ev, workspaceId, receivedAt) {
  if (!ev || typeof ev !== 'object') return null;
  const id = clampStr(ev.id, 128);
  const operator = clampStr(ev.operator, 128);
  const command = clampStr(ev.command, MAX_CMD_LEN);
  const tool = clampStr(ev.tool, 128);
  const startedAt = clampInt(ev.startedAt);
  if (!id || !operator || !command || !tool || startedAt === null) return null;
  return {
    id,
    workspaceId,
    operator,
    command,
    tool,
    cwd: clampStr(ev.cwd),
    host: clampStr(ev.host, 256),
    localUser: clampStr(ev.localUser, 128),
    shellPid: clampInt(ev.shellPid),
    startedAt,
    receivedAt,
    exitCode: clampInt(ev.exitCode),
    durationMs: clampInt(ev.durationMs),
    redacted: ev.redacted === false ? false : true,
  };
}

// Best-effort tool name from a command line (mirrors the agent's matcher, but
// simple): skip env assignments + sudo/doas, then take the basename.
function deriveTool(command) {
  const parts = String(command).trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) i++;
  if (parts[i] === "sudo" || parts[i] === "doas") {
    i++;
    while (i < parts.length && parts[i].startsWith("-")) i++;
  }
  const prog = parts[i] || "manual";
  return prog.split("/").pop() || "manual";
}

// ── Route handlers (called from index.mjs) ──

// POST /api/cmdlog/manual — a BTCT user hand-enters one command-log record
// (JWT-gated in index.mjs). Goes through the same durable path as agent ingest
// (SQLite archive + CRDT live window) so manual entries survive and show up in
// archive queries. Not gated by the ingest token / enabled flag — this is a
// first-class in-app action for any authenticated user. Never redacted: the
// user typed it here deliberately.
export async function handleCmdlogManual(req, res, { sendJson, readJsonBody }) {
  let body;
  try { body = await readJsonBody(req, 32 * 1024); }
  catch (e) { return sendJson(res, 413, { error: String(e?.message || e) }); }

  const operator = clampStr(body.operator, 128);
  const command = clampStr(body.command, MAX_CMD_LEN);
  if (!operator || !command) return sendJson(res, 400, { error: 'operator and command are required' });

  let workspaceId = clampStr(body.workspaceId, 128) || getSetting(T_WORKSPACE) || '';
  if (!workspaceId) {
    try { workspaceId = (await listWorkspaces())[0]?.id || ''; } catch { /* leave empty */ }
  }
  if (!workspaceId) return sendJson(res, 409, { error: 'no target workspace' });

  const now = Date.now();
  const startedAt = clampInt(body.startedAt);
  const rec = {
    id: crypto.randomUUID(),
    workspaceId,
    operator,
    command,
    tool: clampStr(body.tool, 128) || deriveTool(command),
    cwd: clampStr(body.cwd),
    host: clampStr(body.host, 256),
    localUser: clampStr(body.localUser, 128),
    shellPid: clampInt(body.shellPid),
    startedAt: startedAt === null ? now : startedAt,
    receivedAt: now,
    exitCode: clampInt(body.exitCode),
    durationMs: clampInt(body.durationMs),
    redacted: false,
  };

  const merged = upsertCommandLog(rec);
  try { await appendCommandLogs([merged]); } catch (e) { console.warn('[cmdlog] CRDT append failed:', e?.message || e); }
  return sendJson(res, 201, { log: merged });
}

// POST /api/cmdlog/events — batch ingest. Body: { workspace?, events: [...] }.
export async function handleCmdlogEvents(req, res, { sendJson, readJsonBody }) {
  if (!requireIngest(req, res, sendJson)) return;
  let body;
  try { body = await readJsonBody(req, 512 * 1024); }
  catch (e) { return sendJson(res, 413, { error: String(e?.message || e) }); }

  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : [];
  if (!events.length) return sendJson(res, 200, { accepted: 0, skipped: 0 });

  // Resolve the target workspace: batch override → configured default → first
  // workspace in the doc. Without any workspace we can't scope the rows.
  let workspaceId = clampStr(body.workspace, 128) || getSetting(T_WORKSPACE) || '';
  if (!workspaceId) {
    try { workspaceId = (await listWorkspaces())[0]?.id || ''; } catch { /* leave empty */ }
  }
  if (!workspaceId) return sendJson(res, 409, { error: 'no target workspace (set a default in Command Log settings)' });

  const receivedAt = Date.now();
  const records = [];
  let skipped = 0;
  for (const ev of events) {
    const rec = normalizeEvent(ev, workspaceId, receivedAt);
    if (!rec) { skipped++; continue; }
    records.push(rec);
  }

  // SQLite is the source of truth — write it first (merged row reflects prior
  // start/completion halves), then push the merged records into the live CRDT
  // window. If the CRDT write fails (e.g. cold doc), the archive still has them.
  const merged = upsertCommandLogBatch(records);
  try { await appendCommandLogs(merged); } catch (e) { console.warn('[cmdlog] CRDT append failed:', e?.message || e); }

  return sendJson(res, 200, { accepted: records.length, skipped });
}

// GET /api/cmdlog/whitelist — the agent fetches the tool list on start + refresh.
export function handleCmdlogWhitelist(req, res, { sendJson }) {
  if (!requireIngest(req, res, sendJson)) return;
  return sendJson(res, 200, { tools: getWhitelist() });
}

// GET /api/cmdlog/query?workspaceId&operator&tool&host&from&to&q&status&limit
// JWT-authenticated read of the durable archive (auth enforced in index.mjs).
export function handleCmdlogQuery(req, res, { sendJson }) {
  const url = new URL(req.url, 'http://x');
  const p = url.searchParams;
  const workspaceId = String(p.get('workspaceId') || '').trim();
  if (!workspaceId) return sendJson(res, 400, { error: 'workspaceId required' });
  const rows = queryCommandLogs({
    workspaceId,
    operator: p.get('operator') || undefined,
    tool: p.get('tool') || undefined,
    host: p.get('host') || undefined,
    from: p.get('from') ? Number(p.get('from')) : undefined,
    to: p.get('to') ? Number(p.get('to')) : undefined,
    q: p.get('q') || undefined,
    status: p.get('status') || undefined,
    limit: p.get('limit') ? Number(p.get('limit')) : undefined,
  });
  return sendJson(res, 200, { logs: rows });
}

// DELETE /api/cmdlog/logs?workspaceId — admin purge of a workspace's archive.
// (The CRDT live window ages out on its own as new events arrive.)
export function handleCmdlogClear(req, res, { sendJson }) {
  const url = new URL(req.url, 'http://x');
  const workspaceId = String(url.searchParams.get('workspaceId') || '').trim();
  if (!workspaceId) return sendJson(res, 400, { error: 'workspaceId required' });
  clearCommandLogs(workspaceId);
  return sendJson(res, 200, { ok: true });
}
