// ─────────────────────────────────────────────────────────────────────────
// In-app Claude assistant: admin-configured API key + view/edit mode, an
// agentic tool loop over the live workspace data (server/yjs-data.mjs), and an
// SSE stream back to the browser. The API key lives only server-side.
// ─────────────────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk';
import { getSetting, setSetting, listUsers } from './db.mjs';
import * as data from './yjs-data.mjs';

const DEFAULT_MODEL = 'claude-opus-4-8';
const KEY = 'anthropic_api_key';

// ── Admin config (stored in the SQLite settings KV) ──
export function getAiConfig() {
  return {
    enabled: getSetting('ai_enabled') === '1',
    mode: getSetting('ai_mode') === 'edit' ? 'edit' : 'view',
    model: getSetting('ai_model') || DEFAULT_MODEL,
    configured: !!getSetting(KEY),
  };
}

/** Apply an admin config patch. Returns the (key-free) public config. */
export function setAiConfig(body) {
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    setSetting(KEY, body.apiKey.trim());
  }
  if (body.apiKey === null || body.apiKey === '') {
    setSetting(KEY, ''); // explicit clear
  }
  if (body.mode !== undefined) {
    if (body.mode !== 'view' && body.mode !== 'edit') {
      throw new Error('mode must be "view" or "edit"');
    }
    setSetting('ai_mode', body.mode);
  }
  if (typeof body.model === 'string' && body.model.trim()) {
    setSetting('ai_model', body.model.trim());
  }
  if (typeof body.enabled === 'boolean') {
    setSetting('ai_enabled', body.enabled ? '1' : '0');
  }
  return getAiConfig();
}

/** Minimal live check that the configured key/model work, without leaking the key. */
export async function testAiConnection() {
  const apiKey = getSetting(KEY);
  if (!apiKey) throw new Error('no API key configured');
  const client = new Anthropic({ apiKey });
  const model = getSetting('ai_model') || DEFAULT_MODEL;
  await client.messages.create({
    model, max_tokens: 8,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
  });
  return { ok: true, model };
}

// ── Tool catalog ──────────────────────────────────────────────────────────
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });

export const READ_TOOLS = [
  { name: 'list_workspaces', description: 'List all workspaces (id + name).', input_schema: obj({}) },
  { name: 'list_pages', description: 'List note pages in the current workspace.', input_schema: obj({}) },
  { name: 'get_page', description: 'Read one page: metadata + markdown body.', input_schema: obj({ pageId: str('Page id') }, ['pageId']) },
  { name: 'search_pages', description: 'Search page titles, tags, and body text.', input_schema: obj({ query: str('Search text') }, ['query']) },
  { name: 'list_graphs', description: 'List attack-narrative graphs (charts) in the workspace.', input_schema: obj({}) },
  { name: 'get_graph', description: 'Read a graph: all nodes (host/service/credential/finding/pivot) and edges.', input_schema: obj({ graphId: str('Graph id') }, ['graphId']) },
  { name: 'list_findings', description: 'List findings (severity, CVSS, etc.) across the workspace.', input_schema: obj({}) },
  { name: 'list_nmap_scans', description: 'List imported nmap scans, newest first.', input_schema: obj({}) },
  { name: 'get_nmap_hosts', description: 'Read every host in an nmap scan: IP, hostname, OS, open ports with service/version and script output.', input_schema: obj({ scanId: str('Nmap scan id') }, ['scanId']) },
  { name: 'get_nmap_host', description: 'Read one nmap host in full detail by machine id.', input_schema: obj({ machineId: str('Nmap host/machine id') }, ['machineId']) },
  { name: 'recent_changelog', description: 'Recent activity in the workspace.', input_schema: obj({}) },
  { name: 'list_attack_chains', description: 'List saved attack chains (ordered node sequences) in the workspace.', input_schema: obj({}) },
  { name: 'get_attack_chain', description: 'Read one attack chain: its ordered steps (nodes).', input_schema: obj({ chainId: str('Attack chain id') }, ['chainId']) },
  { name: 'attack_timeline', description: 'The attack timeline: all graph nodes across the workspace sorted by discovery time.', input_schema: obj({}) },
  { name: 'list_users', description: 'List app users (username, color, admin role) — no secrets.', input_schema: obj({}) },
];

export const WRITE_TOOLS = [
  { name: 'create_graph', description: 'Create a new empty attack-narrative graph in the workspace. Returns its id so you can then add nodes/edges to it.', input_schema: obj({ name: str('Narrative name') }, ['name']) },
  { name: 'create_page', description: 'Create a new note page with a markdown body.', input_schema: obj({ title: str('Title'), content: str('Markdown body'), tags: { type: 'array', items: { type: 'string' } } }, ['title']) },
  { name: 'update_page_meta', description: "Update a page's title/tags/icon (does not edit an existing rich body).", input_schema: obj({ pageId: str('Page id'), title: str('New title'), tags: { type: 'array', items: { type: 'string' } }, icon: str('Icon') }, ['pageId']) },
  { name: 'create_node', description: 'Add a node to a graph to document a host/service/credential/finding/pivot. `data` matches the node type.', input_schema: obj({ graphId: str('Graph id'), type: { type: 'string', enum: ['host', 'service', 'credential', 'finding', 'pivot'] }, label: str('Node label'), data: { type: 'object', description: 'Type-specific fields (host: hostname/ip/os/openPorts; service: name/version/port/cves; credential: username/secret/source; pivot: description)', additionalProperties: true } }, ['graphId', 'type', 'label']) },
  { name: 'update_node', description: 'Update a node label and/or its data fields.', input_schema: obj({ nodeId: str('Node id'), label: str('New label'), data: { type: 'object', additionalProperties: true } }, ['nodeId']) },
  { name: 'create_edge', description: 'Connect two nodes with a relationship edge.', input_schema: obj({ graphId: str('Graph id'), source: str('Source node id'), target: str('Target node id'), edgeType: { type: 'string', enum: ['AdminTo', 'HasSession', 'MemberOf', 'Exploits', 'PivotsTo', 'Custom'] }, label: str('Edge label') }, ['graphId', 'source', 'target']) },
  { name: 'create_finding', description: 'Add a finding node (with severity/CVSS/etc.) to a graph.', input_schema: obj({ graphId: str('Graph id'), title: str('Finding title'), severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] }, cvss: { type: 'number' }, description: str('Description'), remediation: str('Remediation'), service: str('Affected service'), hosts: { type: 'array', items: { type: 'string' } } }, ['graphId', 'title']) },
  { name: 'link_nmap_host_to_node', description: 'Associate an existing nmap host with an existing graph node.', input_schema: obj({ machineId: str('Nmap host/machine id'), nodeId: str('Graph node id') }, ['machineId', 'nodeId']) },
  { name: 'nmap_host_to_node', description: 'Create a host node from an nmap host (copying IP/OS/open ports) and link them.', input_schema: obj({ machineId: str('Nmap host/machine id'), graphId: str('Graph id to add the node to') }, ['machineId', 'graphId']) },
];

function assertEdit(ctx) {
  if (ctx.mode !== 'edit') throw new Error('The assistant is in view-only mode; ask an admin to enable edit mode.');
}

export async function dispatch(name, input, ctx) {
  const ws = input.workspaceId || ctx.workspaceId;
  switch (name) {
    case 'list_workspaces': return data.listWorkspaces();
    case 'list_pages': return data.listPages(ws);
    case 'get_page': return data.getPage(input.pageId);
    case 'search_pages': return data.searchPages(input.query, ws);
    case 'list_graphs': return data.listGraphs(ws);
    case 'get_graph': return data.getGraph(input.graphId);
    case 'list_findings': return data.listFindings(ws);
    case 'list_nmap_scans': return data.listNmapScans(ws);
    case 'get_nmap_hosts': return data.getNmapHosts(input.scanId);
    case 'get_nmap_host': return data.getNmapHost(input.machineId);
    case 'recent_changelog': return data.recentChangelog(ws);
    case 'list_attack_chains': return data.listAttackChains(ws);
    case 'get_attack_chain': return data.getAttackChain(input.chainId);
    case 'attack_timeline': return data.attackTimeline(ws);
    case 'list_users': return listUsers();
    case 'create_graph': assertEdit(ctx); return data.createGraph({ workspaceId: ws, name: input.name }, ctx.actor);
    case 'create_page': assertEdit(ctx); return data.createPage({ workspaceId: ws, title: input.title, content: input.content, tags: input.tags }, ctx.actor);
    case 'update_page_meta': assertEdit(ctx); return data.updatePageMeta(input.pageId, input, ctx.actor);
    case 'create_node': assertEdit(ctx); return data.createNode({ graphId: input.graphId, type: input.type, label: input.label, data: input.data }, ctx.actor);
    case 'update_node': assertEdit(ctx); return data.updateNode(input.nodeId, input, ctx.actor);
    case 'create_edge': assertEdit(ctx); return data.createEdge({ graphId: input.graphId, source: input.source, target: input.target, edgeType: input.edgeType, label: input.label }, ctx.actor);
    case 'create_finding': assertEdit(ctx); return data.createFinding({ graphId: input.graphId, title: input.title, severity: input.severity, cvss: input.cvss, description: input.description, remediation: input.remediation, service: input.service, hosts: input.hosts }, ctx.actor);
    case 'link_nmap_host_to_node': assertEdit(ctx); return data.linkMachineToNode(input.machineId, input.nodeId, ctx.actor);
    case 'nmap_host_to_node': assertEdit(ctx); return data.nmapHostToNode({ machineId: input.machineId, graphId: input.graphId }, ctx.actor);
    default: throw new Error(`unknown tool ${name}`);
  }
}

function systemPrompt(mode, workspaceId) {
  return [
    'You are the built-in assistant for a collaborative penetration-testing note-taking app.',
    'You help the operator explore a network and document what they find in real time.',
    'You can read the workspace: note pages, attack-narrative graphs (the "charts" of hosts/services/credentials/findings/pivots and the edges between them), the findings register, and imported nmap scans (hosts with open ports, service versions, and NSE script output).',
    mode === 'edit'
      ? 'You are in EDIT mode: you may also create attack-narrative graphs and document findings by creating/updating pages, graph nodes, edges, and findings, and by turning nmap hosts into linked graph nodes. To build a new narrative, call create_graph first, then add nodes/edges to the returned graph id. Prefer small, targeted edits; confirm before large graph rewrites. After scanning, offer to document what was found.'
      : 'You are in VIEW-ONLY mode: you can read and analyze everything but cannot make changes. If asked to edit, explain that an admin must enable edit mode.',
    `The active workspace id is ${workspaceId || '(none selected)'} — scope your tool calls to it.`,
    'When exploring, read the latest nmap scan and the current graph before advising. Ground every recommendation in real data — cite host IPs, node labels, and finding titles. Propose concrete next steps (which ports/services to target, which hosts are undocumented, likely credential-reuse or pivot paths).',
    'Be concise and practical.',
  ].join('\n');
}

// SSE frame helper.
function send(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/**
 * Handle POST /api/ai/chat. `res` headers for SSE are set here. `user` is the
 * authenticated actor (for change-log provenance). Body: { messages, workspaceId }.
 */
export async function handleAiChat(req, res, { user, body, setCors }) {
  const cfg = getAiConfig();
  const apiKey = getSetting(KEY);
  if (!cfg.enabled || !apiKey) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: cfg.enabled ? 'assistant not configured' : 'assistant disabled' }));
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null;
  const ctx = {
    mode: cfg.mode,
    workspaceId,
    actor: { userId: user?.id ?? null, userName: user?.username ?? 'Claude', userColor: user?.color ?? '#d97757' },
  };
  const tools = cfg.mode === 'edit' ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  const client = new Anthropic({ apiKey });

  setCors?.(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const convo = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));

  try {
    let rounds = 0;
    while (rounds++ < 12) {
      const stream = client.messages.stream({
        model: cfg.model,
        max_tokens: 4096,
        system: systemPrompt(cfg.mode, workspaceId),
        tools,
        messages: convo,
      });
      stream.on('text', (delta) => send(res, { type: 'text', text: delta }));
      const final = await stream.finalMessage();
      convo.push({ role: 'assistant', content: final.content });

      if (final.stop_reason !== 'tool_use') break;

      const results = [];
      for (const block of final.content) {
        if (block.type !== 'tool_use') continue;
        send(res, { type: 'tool', name: block.name });
        let out;
        let isErr = false;
        try {
          out = await dispatch(block.name, block.input || {}, ctx);
        } catch (e) {
          out = { error: String(e?.message || e) };
          isErr = true;
        }
        // Tell the client the call finished so its activity indicator can move
        // off "running <tool>" — otherwise a slow round looks stuck on the
        // last tool right through the model's next thinking pass.
        send(res, { type: 'tool_done', name: block.name, ok: !isErr });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out ?? null), is_error: isErr });
      }
      convo.push({ role: 'user', content: results });
      // Another pass over the tool results is about to start. `round` is what
      // lets the UI distinguish a quick answer from extended research.
      send(res, { type: 'round', n: rounds });
    }
    send(res, { type: 'done' });
  } catch (e) {
    send(res, { type: 'error', error: String(e?.message || e) });
  } finally {
    res.end();
  }
}
