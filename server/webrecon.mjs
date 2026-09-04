// ─────────────────────────────────────────────────────────────────────────
// Web recon: ingest + server-side scan for the btct-webrecon tool.
//
// Two producers feed the same shared-doc write path (ingestSiteMap in
// yjs-data.mjs):
//   • an external recon script (../webrecon-agent) POSTs a normalized "BTCT
//     sitemap JSON" document here with a static bearer token (like cmdlog);
//   • the in-app "Scan now" button spawns that same script server-side (Linux
//     only, admin-enabled) and ingests its stdout.
//
// Like cmdlog.mjs this is a deliberate exception to "the server is dumb about
// domain data": it validates/clamps a recon document and stores it, and knows
// nothing about what a URL means. The scan spawn is fully async (Bun.spawn) so
// it never blocks the Yjs relay (invariant #9), single-flighted, wall-clock
// bounded, and gated by an anti-SSRF scope guard.
// ─────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getSetting, setSetting } from './db.mjs';
import { ingestSiteMap, listWorkspaces } from './yjs-data.mjs';
import { normalizeSitemapDoc, assertScanTargetAllowed, isBlockedHostLiteral } from './webrecon-scope.mjs';

const T_INGEST = 'webrecon_ingest_enabled';
const T_TOKEN = 'webrecon_token';
const T_SCAN = 'webrecon_scan_enabled';
const T_WORKSPACE = 'webrecon_workspace';

const MAX_URL = 2048;
const MAX_STR = 512;

const MAX_SCAN_MS = 180000;   // wall-clock cap on a server-side scan
const MAX_SCAN_PAGES = 400;   // crawl budget for the built-in engine

// Clamp a request-body string field.
const str = (v, max = MAX_STR) => (v === undefined || v === null) ? '' : String(v).slice(0, max);

const genToken = () => 'btct_ing_' + crypto.randomBytes(24).toString('hex');

// ── Admin config (token IS returned to admins, like cmdlog/mcp) ──
export function getWebreconConfig() {
  return {
    ingestEnabled: getSetting(T_INGEST) === '1',
    scanEnabled: getSetting(T_SCAN) === '1',
    configured: !!getSetting(T_TOKEN),
    token: getSetting(T_TOKEN) || null,
    workspaceId: getSetting(T_WORKSPACE) || null,
    platformSupported: platformSupportsScan(),
  };
}

export function setWebreconConfig(body) {
  if (typeof body.ingestEnabled === 'boolean') {
    setSetting(T_INGEST, body.ingestEnabled ? '1' : '0');
    if (body.ingestEnabled && !getSetting(T_TOKEN)) setSetting(T_TOKEN, genToken());
  }
  if (typeof body.scanEnabled === 'boolean') {
    setSetting(T_SCAN, body.scanEnabled ? '1' : '0');
  }
  if (body.workspaceId !== undefined) {
    setSetting(T_WORKSPACE, body.workspaceId ? String(body.workspaceId) : '');
  }
  return getWebreconConfig();
}

export function regenerateWebreconToken() {
  const t = genToken();
  setSetting(T_TOKEN, t);
  return t;
}

/** The server can only spawn the scanner on a Linux host (the first platform check). */
export function platformSupportsScan() {
  return process.platform === 'linux';
}

export function getWebreconScanStatus() {
  return {
    scanEnabled: getSetting(T_SCAN) === '1',
    platformSupported: platformSupportsScan(),
    running: scanInProgress,
  };
}

// ── Bearer gate (identical shape to cmdlog.mjs) ──
function constantEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireIngest(req, res, sendJson) {
  const token = getSetting(T_TOKEN);
  if (getSetting(T_INGEST) !== '1' || !token) {
    sendJson(res, 401, { error: 'web recon ingest disabled' });
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

// ── Route handlers ──

// POST /api/webrecon/ingest: token-gated ingest of a normalized document.
// Body: { workspaceId?, siteMapId?, name?, ...document }.
export async function handleWebreconIngest(req, res, { sendJson, readJsonBody }) {
  if (!requireIngest(req, res, sendJson)) return;
  let body;
  try { body = await readJsonBody(req, 8 * 1024 * 1024); }
  catch (e) { return sendJson(res, 413, { error: String(e?.message || e) }); }

  let doc;
  try { doc = normalizeSitemapDoc(body); }
  catch (e) { return sendJson(res, 400, { error: String(e?.message || e) }); }

  const workspaceId = str(body.workspaceId, 128) || getSetting(T_WORKSPACE) || (await firstWorkspace());
  if (!workspaceId) return sendJson(res, 409, { error: 'no target workspace (set a default in Web Recon settings)' });

  try {
    const r = await ingestSiteMap({
      workspaceId,
      siteMapId: str(body.siteMapId, 128) || undefined,
      name: str(body.name, MAX_STR) || undefined,
      rootUrl: doc.target,
      nodes: doc.nodes,
      edges: doc.edges,
      scannedAt: doc.scannedAt,
    }, { userName: 'webrecon' });
    return sendJson(res, 200, { ...r });
  } catch (e) {
    return sendJson(res, 500, { error: String(e?.message || e) });
  }
}

// POST /api/webrecon/scan: spawn the bundled scanner (Linux, admin-enabled).
// Body: { target, siteMapId?, workspaceId? }. JWT is checked in index.mjs.
let scanInProgress = false;

export async function handleWebreconScan(req, res, { sendJson, readJsonBody }, actor) {
  if (getSetting(T_SCAN) !== '1') return sendJson(res, 403, { error: 'server-side scanning is disabled' });
  if (!platformSupportsScan()) return sendJson(res, 400, { error: 'server-side scanning requires a Linux host' });

  let body;
  try { body = await readJsonBody(req, 16 * 1024); }
  catch (e) { return sendJson(res, 413, { error: String(e?.message || e) }); }

  const target = str(body.target, MAX_URL).trim();
  if (!target) return sendJson(res, 400, { error: 'target is required' });
  let u;
  try { u = assertScanTargetAllowed(target); }
  catch (e) { return sendJson(res, 400, { error: String(e?.message || e) }); }

  // DNS-resolve the host and re-check: a public name must not point at an
  // internal address (DNS-rebinding / SSRF).
  try {
    const addrs = await dns.lookup(u.hostname, { all: true });
    for (const a of addrs) {
      if (isBlockedHostLiteral(a.address)) {
        return sendJson(res, 400, { error: 'target resolves to a private/internal address' });
      }
    }
  } catch {
    return sendJson(res, 400, { error: 'target host could not be resolved' });
  }

  if (scanInProgress) return sendJson(res, 409, { error: 'a scan is already running' });
  scanInProgress = true;
  try {
    const doc = await runScanScript(target);
    const workspaceId = str(body.workspaceId, 128) || getSetting(T_WORKSPACE) || (await firstWorkspace());
    if (!workspaceId) return sendJson(res, 409, { error: 'no target workspace' });
    const r = await ingestSiteMap({
      workspaceId,
      siteMapId: str(body.siteMapId, 128) || undefined,
      name: str(body.name, MAX_STR) || undefined,
      rootUrl: doc.target || target,
      nodes: doc.nodes,
      edges: doc.edges,
      scannedAt: doc.scannedAt,
    }, actor || { userName: 'webrecon' });
    return sendJson(res, 200, { ...r });
  } catch (e) {
    return sendJson(res, 500, { error: String(e?.message || e) });
  } finally {
    scanInProgress = false;
  }
}

// Spawn `python3 -m btct_webrecon <target> --emit-json` in the agent dir and
// parse its stdout. Fully async, wall-clock bounded, output-size capped.
async function runScanScript(target) {
  const agentDir = path.resolve(fileURLToPath(new URL('../webrecon-agent', import.meta.url)));
  const cmd = [
    'python3', '-m', 'btct_webrecon', target,
    '--emit-json',
    '--max-pages', String(MAX_SCAN_PAGES),
    '--timeout', String(Math.floor(MAX_SCAN_MS / 1000)),
  ];
  const proc = Bun.spawn({
    cmd,
    cwd: agentDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* ignore */ } }, MAX_SCAN_MS);
  let out = '';
  try {
    out = await new Response(proc.stdout).text();
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) throw new Error('scan timed out');
  if (!out.trim()) {
    const err = await new Response(proc.stderr).text().catch(() => '');
    throw new Error(`scanner produced no output${err ? `: ${err.slice(0, 300)}` : ''}`);
  }
  let obj;
  try { obj = JSON.parse(out); }
  catch { throw new Error('scanner output was not valid JSON'); }
  return normalizeSitemapDoc(obj);
}

async function firstWorkspace() {
  try { return (await listWorkspaces())[0]?.id || ''; } catch { return ''; }
}
