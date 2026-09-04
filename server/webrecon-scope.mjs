// ─────────────────────────────────────────────────────────────────────────
// Pure web-recon helpers: the anti-SSRF scope guard and the sitemap-document
// normalizer (server-side twin of src/lib/sitemap-parser.ts). No db/yjs
// imports, so it is unit-testable from src/test (see webrecon-scope.d.mts).
// ─────────────────────────────────────────────────────────────────────────

const NODE_TYPES = new Set(['root', 'subdomain', 'page', 'endpoint', 'api', 'js', 'form', 'external']);
const EDGE_KINDS = new Set(['link', 'redirect', 'hierarchy', 'form-action', 'api-ref']);

const MAX_NODES = 20000;
const MAX_EDGES = 40000;
const MAX_URL = 2048;
const MAX_STR = 512;
const MAX_LIST = 64;

const str = (v, max = MAX_STR) => (v === undefined || v === null) ? '' : String(v).slice(0, max);
const intOrNull = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);

function strList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const item of v) {
    const s = str(item, 256).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

export function computeKey(type, url, method) {
  return `${type}|${(method || '').toUpperCase()}|${url}`;
}

function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = NODE_TYPES.has(str(raw.type, 32).toLowerCase()) ? str(raw.type, 32).toLowerCase() : 'page';
  const url = str(raw.url, MAX_URL).trim();
  const method = str(raw.method, 16).toUpperCase();
  if (!url && !raw.key) return null;
  const key = str(raw.key, MAX_URL + 64).trim() || computeKey(type, url, method);
  return {
    key, type, url, method,
    status: intOrNull(raw.status),
    contentType: str(raw.contentType, 128),
    title: str(raw.title, MAX_STR),
    size: intOrNull(raw.size),
    params: strList(raw.params),
    sources: strList(raw.sources),
    tags: strList(raw.tags),
    notes: str(raw.notes, 4096),
  };
}

export function normalizeSitemapDoc(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('not a sitemap document');
  const rawNodes = Array.isArray(obj.nodes) ? obj.nodes.slice(0, MAX_NODES) : [];
  const rawEdges = Array.isArray(obj.edges) ? obj.edges.slice(0, MAX_EDGES) : [];
  const byKey = new Map();
  for (const rn of rawNodes) {
    const n = normalizeNode(rn);
    if (n) byKey.set(n.key, n);
  }
  const nodes = [...byKey.values()];
  const keys = new Set(nodes.map((n) => n.key));
  const edges = [];
  const seen = new Set();
  for (const re of rawEdges) {
    if (!re || typeof re !== 'object') continue;
    const source = str(re.source, MAX_URL + 64).trim();
    const target = str(re.target, MAX_URL + 64).trim();
    if (!source || !target || source === target) continue;
    if (!keys.has(source) || !keys.has(target)) continue;
    const kind = EDGE_KINDS.has(str(re.kind, 32).toLowerCase()) ? str(re.kind, 32).toLowerCase() : 'link';
    const dedupe = `${source} ${target} ${kind}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    edges.push({ source, target, kind, label: str(re.label, 128) });
  }
  const scannedAt = intOrNull(obj.scannedAt);
  return {
    target: str(obj.target, MAX_URL),
    scannedAt: scannedAt && scannedAt > 0 ? scannedAt : Date.now(),
    nodes, edges,
  };
}

// ── Anti-SSRF scope guard ──
function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return p;
}

export function isBlockedIPv4(a, b, c, d) {
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                         // private
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local incl 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // private
  if (a === 192 && b === 168) return true;           // private
  if (a === 192 && b === 0 && c === 0) return true;  // 192.0.0.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                         // multicast + reserved + broadcast
  return false;
}

export function isBlockedIPv6(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::' || h === '::0') return true;
  if (h.includes('%')) return true;                  // zone id / link-local
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) {
    const v4 = parseIPv4(mapped[1]);
    return v4 ? isBlockedIPv4(...v4) : true;
  }
  const head = h.split(':')[0] || '';
  if (head.startsWith('fc') || head.startsWith('fd')) return true; // ULA fc00::/7
  if (head.startsWith('fe8') || head.startsWith('fe9') || head.startsWith('fea') || head.startsWith('feb')) return true; // link-local fe80::/10
  return false;
}

export function isBlockedHostLiteral(host) {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = parseIPv4(h);
  if (v4) return isBlockedIPv4(...v4);
  if (h.includes(':')) return isBlockedIPv6(h);
  return false;
}

export function assertScanTargetAllowed(target) {
  let u;
  try { u = new URL(target); } catch { throw new Error('invalid target URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('target must be http(s)');
  if (isBlockedHostLiteral(u.hostname)) throw new Error('target host is not allowed (private/internal address)');
  return u;
}
