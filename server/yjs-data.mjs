// ─────────────────────────────────────────────────────────────────────────
// Server-side access to the shared Yjs workspace document ("btct-shared").
//
// The whole app state (workspaces, pages, graphs, nodes, edges, findings,
// nmap scans/hosts, attack chains, change log) lives in ONE Yjs doc that every
// browser client edits collaboratively. y-websocket keeps that doc resident in
// this process (utils' `docs` map / `getYDoc`), so the AI assistant's tools can
// read and write it in-process — writes broadcast to every connected client and
// show up live on their canvas.
//
// Two invariants when writing (mirroring the client repos in src/db/*-repo.ts):
//   1. Collaborative string fields (page title/slug, node/edge label, nmap
//      hostname, …) are authoritative as a Y.Text in the `texts` map keyed
//      `<entity>:<id>:<field>`. A client observer mirrors that Y.Text back into
//      the JSON record — so a record-only write is clobbered. We update BOTH.
//   2. Records are plain JSON keyed by id in a per-table Y.Map (last-writer-
//      wins). Wrap writes in `doc.transact` so observers fire once.
// ─────────────────────────────────────────────────────────────────────────
import { createRequire } from 'node:module';

// Load BOTH y-websocket's helpers AND Yjs itself through the SAME CJS module
// instance y-websocket uses internally. If we imported Yjs via ESM instead we'd
// get a second Yjs instance ("Yjs was already imported" warning) whose `Y.Text`
// class the shared doc wouldn't recognize — breaking collaborative-text writes.
const require = createRequire(import.meta.url);
const { getYDoc } = require('y-websocket/bin/utils');
const Y = require('yjs');

const ROOM = 'btct-shared';
const TABLE_NAMES = [
  'workspaces', 'pages', 'graphs', 'graphNodes', 'graphEdges',
  'attackChains', 'changeLogs', 'nmapScans', 'nmapMachines', 'commandLogs',
];

// The shared doc holds only a bounded live window of command logs per workspace
// (the durable archive is SQLite). Keep memory + render cost small on clients.
const CMDLOG_LIVE_CAP = 500;

function textKey(entity, id, field) {
  return `${entity}:${id}:${field}`;
}

function uuid() {
  return crypto.randomUUID();
}

// Resolve the live shared doc + its table maps. If no client is connected and
// the doc was just created, its LevelDB state loads asynchronously — poll
// briefly until it's populated (or give up so a genuinely empty app doesn't
// stall). In practice the operator's browser is connected, so this returns
// immediately with a fully-synced doc.
async function shared() {
  const doc = getYDoc(ROOM);
  const tables = {};
  for (const name of TABLE_NAMES) tables[name] = doc.getMap(name);
  const texts = doc.getMap('texts');
  const start = Date.now();
  while (tables.workspaces.size === 0 && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { doc, tables, texts };
}

function setText(texts, key, value) {
  let t = texts.get(key);
  if (!t) {
    t = new Y.Text();
    texts.set(key, t);
  }
  const cur = t.toString();
  if (cur === value) return;
  if (cur.length) t.delete(0, cur.length);
  if (value) t.insert(0, value);
}

function values(map) {
  return [...map.values()];
}

// ── Change log (provenance for every AI write) ──
function logChange(tables, workspaceId, action, target, targetId, summary, actor) {
  const entry = {
    id: uuid(),
    workspaceId,
    action,
    target,
    targetId,
    summary,
    timestamp: Date.now(),
    userId: actor?.userId ?? null,
    userName: actor?.userName ?? 'Claude',
    userColor: actor?.userColor ?? '#d97757',
    field: null,
    prevValue: null,
    newValue: null,
    reversible: false,
  };
  tables.changeLogs.set(entry.id, entry);
}

// ── Default node data (mirror src/types/index.ts) ──
function defaultFindingData() {
  return {
    title: '', severity: 'info', cvss: 0, cvssVector: '', likelihood: 'info',
    impact: 'info', description: '', businessImpact: '', exploitSteps: '',
    mitreAttack: '', mitreMitigation: '', remediation: '', hosts: [], service: '',
    references: [],
  };
}
function defaultNodeData(type) {
  switch (type) {
    case 'host': return { hostname: '', ip: '', os: '', openPorts: [] };
    case 'credential': return { username: '', secret: '', source: '' };
    case 'service': return { name: '', version: '', port: 0, cves: [] };
    case 'finding': return defaultFindingData();
    case 'pivot': return { description: '' };
    default: return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────
// READ helpers
// ─────────────────────────────────────────────────────────────────────────

export async function listWorkspaces() {
  const { tables } = await shared();
  return values(tables.workspaces).map((w) => ({
    id: w.id, name: w.name, description: w.description,
  }));
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  return ''; // legacy BlockNote arrays aren't rendered server-side
}

export async function listPages(workspaceId) {
  const { tables } = await shared();
  return values(tables.pages)
    .filter((p) => (!workspaceId || p.workspaceId === workspaceId) && !p.isGraphPage)
    .map((p) => ({ id: p.id, title: p.title, tags: p.tags ?? [], parentId: p.parentId ?? null }));
}

export async function getPage(id) {
  const { tables } = await shared();
  const p = tables.pages.get(id);
  if (!p) return null;
  return {
    id: p.id, title: p.title, tags: p.tags ?? [], icon: p.icon ?? '',
    isGraphPage: !!p.isGraphPage, content: contentToText(p.content),
  };
}

export async function searchPages(query, workspaceId) {
  const { tables } = await shared();
  const q = String(query || '').toLowerCase();
  return values(tables.pages)
    .filter((p) => !workspaceId || p.workspaceId === workspaceId)
    .filter((p) =>
      (p.title || '').toLowerCase().includes(q) ||
      (p.tags ?? []).some((t) => t.toLowerCase().includes(q)) ||
      contentToText(p.content).toLowerCase().includes(q))
    .slice(0, 25)
    .map((p) => ({ id: p.id, title: p.title, snippet: contentToText(p.content).slice(0, 200) }));
}

export async function listGraphs(workspaceId) {
  const { tables } = await shared();
  return values(tables.graphs)
    .filter((g) => !workspaceId || g.workspaceId === workspaceId)
    .map((g) => ({ id: g.id, name: g.name }));
}

export async function getGraph(id) {
  const { tables } = await shared();
  const g = tables.graphs.get(id);
  if (!g) return null;
  const nodes = values(tables.graphNodes)
    .filter((n) => n.graphId === id)
    .map((n) => ({ id: n.id, type: n.type, label: n.label, data: n.data, linkedPageId: n.linkedPageId }));
  const edges = values(tables.graphEdges)
    .filter((e) => e.graphId === id)
    .map((e) => ({ id: e.id, source: e.sourceNodeId, target: e.targetNodeId, edgeType: e.edgeType, label: e.label }));
  return { id: g.id, name: g.name, nodes, edges };
}

export async function listFindings(workspaceId) {
  const { tables } = await shared();
  const graphWs = new Map(values(tables.graphs).map((g) => [g.id, g.workspaceId]));
  return values(tables.graphNodes)
    .filter((n) => n.type === 'finding')
    .filter((n) => !workspaceId || graphWs.get(n.graphId) === workspaceId)
    .map((n) => ({ id: n.id, graphId: n.graphId, label: n.label, ...n.data }));
}

export async function listAttackChains(workspaceId) {
  const { tables } = await shared();
  return values(tables.attackChains)
    .filter((c) => !workspaceId || c.workspaceId === workspaceId)
    .map((c) => ({ id: c.id, graphId: c.graphId, name: c.name, nodeIds: c.nodeIds ?? [], linkedPageId: c.linkedPageId ?? null }));
}

export async function getAttackChain(id) {
  const { tables } = await shared();
  const c = tables.attackChains.get(id);
  if (!c) return null;
  // Resolve the ordered node ids to labels for readability.
  const steps = (c.nodeIds ?? []).map((nid) => {
    const n = tables.graphNodes.get(nid);
    return n ? { id: nid, type: n.type, label: n.label } : { id: nid };
  });
  return { id: c.id, graphId: c.graphId, name: c.name, nodeIds: c.nodeIds ?? [], steps, linkedPageId: c.linkedPageId ?? null };
}

/** All graph nodes across the workspace, sorted by when they were discovered. */
export async function attackTimeline(workspaceId) {
  const { tables } = await shared();
  const graphWs = new Map(values(tables.graphs).map((g) => [g.id, g.workspaceId]));
  return values(tables.graphNodes)
    .filter((n) => !workspaceId || graphWs.get(n.graphId) === workspaceId)
    .sort((a, b) => (a.discoveredAt || a.createdAt || 0) - (b.discoveredAt || b.createdAt || 0))
    .map((n) => ({ id: n.id, graphId: n.graphId, type: n.type, label: n.label, discoveredAt: n.discoveredAt ?? n.createdAt, data: n.data }));
}

export async function listNmapScans(workspaceId) {
  const { tables } = await shared();
  return values(tables.nmapScans)
    .filter((s) => !workspaceId || s.workspaceId === workspaceId)
    .sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0))
    .map((s) => ({ id: s.id, name: s.name, importedAt: s.importedAt }));
}

function hostSummary(m) {
  return {
    id: m.id, ip: m.ip, hostname: m.hostname, os: m.os,
    linkedNodeId: m.linkedNodeId ?? null,
    ports: (m.ports ?? []).map((p) => ({
      port: p.port, protocol: p.protocol, state: p.state, service: p.service,
      version: p.version,
      scripts: (p.scripts ?? []).map((s) => ({ id: s.id, output: (s.output || '').slice(0, 600) })),
    })),
  };
}

export async function getNmapHosts(scanId) {
  const { tables } = await shared();
  return values(tables.nmapMachines).filter((m) => m.scanId === scanId).map(hostSummary);
}

export async function getNmapHost(machineId) {
  const { tables } = await shared();
  const m = tables.nmapMachines.get(machineId);
  return m ? hostSummary(m) : null;
}

export async function recentChangelog(workspaceId, limit = 30) {
  const { tables } = await shared();
  return values(tables.changeLogs)
    .filter((e) => !workspaceId || e.workspaceId === workspaceId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map((e) => ({ action: e.action, target: e.target, summary: e.summary, by: e.userName, at: e.timestamp }));
}

// ── Command log (team pentest command activity) ──
// Batch-upsert records into the live window. Unlike the AI write helpers this
// has NO Y.Text fields (like typstAssets) — every field is plain LWW JSON, so
// invariant #1 doesn't apply. A completion event (exitCode/durationMs) is
// merged over the existing start record by id. After each batch we prune the
// oldest entries per workspace beyond CMDLOG_LIVE_CAP so the doc stays bounded.
export async function appendCommandLogs(records) {
  if (!records || !records.length) return;
  const { doc, tables } = await shared();
  doc.transact(() => {
    for (const r of records) {
      const existing = tables.commandLogs.get(r.id);
      tables.commandLogs.set(r.id, existing ? { ...existing, ...r } : r);
    }
    pruneCommandLogs(tables.commandLogs);
  });
}

function pruneCommandLogs(map) {
  const byWs = new Map();
  for (const rec of map.values()) {
    const arr = byWs.get(rec.workspaceId) || [];
    arr.push(rec);
    byWs.set(rec.workspaceId, arr);
  }
  for (const arr of byWs.values()) {
    if (arr.length <= CMDLOG_LIVE_CAP) continue;
    arr.sort((a, b) => a.startedAt - b.startedAt); // oldest first
    for (const rec of arr.slice(0, arr.length - CMDLOG_LIVE_CAP)) map.delete(rec.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// WRITE helpers (edit mode only — the caller gates on ai_mode)
// ─────────────────────────────────────────────────────────────────────────

export async function createPage({ workspaceId, parentId = null, title, tags = [], content = '', icon = '' }, actor) {
  const { doc, tables, texts } = await shared();
  const now = Date.now();
  const id = uuid();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const page = {
    id, workspaceId, parentId, title, slug, icon, tags,
    content: typeof content === 'string' ? content : '',
    sortOrder: 0, isGraphPage: false, createdAt: now, updatedAt: now,
  };
  doc.transact(() => {
    tables.pages.set(id, page);
    setText(texts, textKey('page', id, 'title'), title);
    setText(texts, textKey('page', id, 'slug'), slug);
    logChange(tables, workspaceId, 'create', 'page', id, `Created page "${title}"`, actor);
  });
  return { id, title };
}

export async function updatePageMeta(id, patch, actor) {
  const { doc, tables, texts } = await shared();
  const cur = tables.pages.get(id);
  if (!cur) throw new Error(`page ${id} not found`);
  const next = { ...cur, updatedAt: Date.now() };
  if (typeof patch.title === 'string') next.title = patch.title;
  if (Array.isArray(patch.tags)) next.tags = patch.tags;
  if (typeof patch.icon === 'string') next.icon = patch.icon;
  if (typeof patch.content === 'string') next.content = patch.content;
  doc.transact(() => {
    tables.pages.set(id, next);
    if (typeof patch.title === 'string') setText(texts, textKey('page', id, 'title'), patch.title);
    logChange(tables, cur.workspaceId, 'update', 'page', id, `Updated page "${next.title}"`, actor);
  });
  return { id, title: next.title };
}

export async function createGraph({ workspaceId, name }, actor) {
  const { doc, tables, texts } = await shared();
  const now = Date.now();
  const id = uuid();
  const nm = name || 'New Attack Narrative';
  doc.transact(() => {
    tables.graphs.set(id, { id, workspaceId, name: nm, createdAt: now, updatedAt: now });
    setText(texts, textKey('graph', id, 'name'), nm); // `name` is a collaborative Y.Text field
    logChange(tables, workspaceId, 'create', 'graph', id, `Created attack narrative "${nm}"`, actor);
  });
  return { id, name: nm };
}

function nextPosition(tables, graphId) {
  const count = values(tables.graphNodes).filter((n) => n.graphId === graphId).length;
  return { x: 120 + (count % 6) * 200, y: 120 + Math.floor(count / 6) * 140 };
}

export async function createNode({ graphId, type, label, data, position }, actor) {
  const { doc, tables, texts } = await shared();
  const graph = tables.graphs.get(graphId);
  if (!graph) throw new Error(`graph ${graphId} not found`);
  const now = Date.now();
  const pageId = uuid();
  const nodeId = uuid();
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const nodeData = { ...defaultNodeData(type), ...(data || {}) };
  const pos = position || nextPosition(tables, graphId);
  doc.transact(() => {
    // Linked (hidden) page, mirroring graphNodeRepo.create.
    tables.pages.set(pageId, {
      id: pageId, workspaceId: graph.workspaceId, parentId: null, title: label,
      slug, icon: '', tags: [], content: '', sortOrder: 0, isGraphPage: true,
      createdAt: now, updatedAt: now,
    });
    setText(texts, textKey('page', pageId, 'title'), label);
    setText(texts, textKey('page', pageId, 'slug'), slug);
    // The node.
    tables.graphNodes.set(nodeId, {
      id: nodeId, graphId, type, label, position: pos, data: nodeData,
      linkedPageId: pageId, discoveredAt: now, createdAt: now, updatedAt: now,
    });
    setText(texts, textKey('node', nodeId, 'label'), label);
    logChange(tables, graph.workspaceId, 'create', 'node', nodeId, `Added ${type} node "${label}"`, actor);
  });
  return { id: nodeId, type, label };
}

export async function updateNode(id, patch, actor) {
  const { doc, tables, texts } = await shared();
  const cur = tables.graphNodes.get(id);
  if (!cur) throw new Error(`node ${id} not found`);
  const graph = tables.graphs.get(cur.graphId);
  const next = { ...cur, updatedAt: Date.now() };
  if (typeof patch.label === 'string') next.label = patch.label;
  if (patch.data && typeof patch.data === 'object') next.data = { ...cur.data, ...patch.data };
  doc.transact(() => {
    tables.graphNodes.set(id, next);
    if (typeof patch.label === 'string') setText(texts, textKey('node', id, 'label'), patch.label);
    logChange(tables, graph?.workspaceId, 'update', 'node', id, `Updated node "${next.label}"`, actor);
  });
  return { id, label: next.label };
}

export async function createEdge({ graphId, source, target, edgeType = 'Custom', label }, actor) {
  const { doc, tables, texts } = await shared();
  const graph = tables.graphs.get(graphId);
  if (!graph) throw new Error(`graph ${graphId} not found`);
  const now = Date.now();
  const id = uuid();
  const lbl = label ?? edgeType;
  doc.transact(() => {
    tables.graphEdges.set(id, {
      id, graphId, sourceNodeId: source, targetNodeId: target, edgeType,
      label: lbl, linkedPageId: null, createdAt: now, updatedAt: now,
    });
    setText(texts, textKey('edge', id, 'label'), lbl);
    logChange(tables, graph.workspaceId, 'create', 'edge', id, `Connected nodes (${edgeType})`, actor);
  });
  return { id, edgeType, label: lbl };
}

export async function createFinding({ graphId, position, ...findingData }, actor) {
  const label = findingData.title || 'Finding';
  return createNode({ graphId, type: 'finding', label, data: { ...defaultFindingData(), ...findingData, title: label }, position }, actor);
}

export async function linkMachineToNode(machineId, nodeId, actor) {
  const { doc, tables } = await shared();
  const m = tables.nmapMachines.get(machineId);
  if (!m) throw new Error(`nmap host ${machineId} not found`);
  const node = tables.graphNodes.get(nodeId);
  const graph = node ? tables.graphs.get(node.graphId) : null;
  doc.transact(() => {
    tables.nmapMachines.set(machineId, { ...m, linkedNodeId: nodeId, updatedAt: Date.now() });
    logChange(tables, graph?.workspaceId ?? m.workspaceId, 'update', 'node', nodeId, `Linked nmap host ${m.ip} to node`, actor);
  });
  return { machineId, nodeId };
}

// Convenience: turn a scanned host into a documented host node + link it.
export async function nmapHostToNode({ machineId, graphId }, actor) {
  const { tables } = await shared();
  const m = tables.nmapMachines.get(machineId);
  if (!m) throw new Error(`nmap host ${machineId} not found`);
  const openPorts = (m.ports ?? []).filter((p) => p.state === 'open').map((p) => p.port);
  const label = m.hostname || m.ip || 'host';
  const node = await createNode({
    graphId, type: 'host', label,
    data: { hostname: m.hostname || '', ip: m.ip || '', os: m.os || '', openPorts },
  }, actor);
  await linkMachineToNode(machineId, node.id, actor);
  return { nodeId: node.id, label, linkedHost: m.ip };
}
