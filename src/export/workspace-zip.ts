import JSZip from 'jszip';
import * as Y from 'yjs';
import type {
  Workspace, Page, Graph, GraphNode, GraphEdge,
  AttackChain, ChangeLogEntry, NmapScan, NmapMachine, PageSnapshot,
  SiteMap, SiteMapNode, SiteMapEdge,
} from '@/types';
import { toGraphML } from './graphml';
import { pageToMarkdown } from './markdown';
import { getPageYContext } from '@/realtime/yjs-providers';

/**
 * Lossless workspace export: every entity table tied to the workspace
 * plus the raw Yjs binary update of every page body (for roundtrip
 * fidelity of collab history, formatting marks, embedded blocks).
 *
 * Backwards-compatible: the importer reads the legacy v1 layout as well
 * (workspace + pages + graphs/nodes/edges), so older zips still load.
 */
export interface WorkspaceExportData {
  schemaVersion: 2;
  exportedAt: number;
  workspace: Workspace;
  pages: Page[];
  graphs: Graph[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  attackChains: AttackChain[];
  changeLogs: ChangeLogEntry[];
  nmapScans: NmapScan[];
  nmapMachines: NmapMachine[];
  pageSnapshots: PageSnapshot[];
  siteMaps: SiteMap[];
  siteMapNodes: SiteMapNode[];
  siteMapEdges: SiteMapEdge[];
  /** Map<pageId, base64 of Y.encodeStateAsUpdate(pageDoc)>. Optional:
   *  set only when the page's Y.Doc was reachable at export time. */
  pageYjsUpdates: Record<ID, string>;
}

type ID = string;

/**
 * Export full workspace to a zip file.
 */
export async function exportWorkspaceZip(data: WorkspaceExportData): Promise<Blob> {
  const zip = new JSZip();

  zip.file('manifest.json', JSON.stringify({
    schemaVersion: data.schemaVersion,
    exportedAt: data.exportedAt,
    workspaceId: data.workspace.id,
    counts: {
      pages: data.pages.length,
      graphs: data.graphs.length,
      graphNodes: data.graphNodes.length,
      graphEdges: data.graphEdges.length,
      attackChains: data.attackChains.length,
      changeLogs: data.changeLogs.length,
      nmapScans: data.nmapScans.length,
      nmapMachines: data.nmapMachines.length,
      pageSnapshots: data.pageSnapshots.length,
      siteMaps: data.siteMaps.length,
      siteMapNodes: data.siteMapNodes.length,
      siteMapEdges: data.siteMapEdges.length,
      pageYjsUpdates: Object.keys(data.pageYjsUpdates).length,
    },
  }, null, 2));

  zip.file('workspace.json',     JSON.stringify(data.workspace,     null, 2));
  zip.file('pages.json',         JSON.stringify(data.pages,         null, 2));
  zip.file('graphs.json',        JSON.stringify(data.graphs,        null, 2));
  zip.file('graphNodes.json',    JSON.stringify(data.graphNodes,    null, 2));
  zip.file('graphEdges.json',    JSON.stringify(data.graphEdges,    null, 2));
  zip.file('attackChains.json',  JSON.stringify(data.attackChains,  null, 2));
  zip.file('changeLogs.json',    JSON.stringify(data.changeLogs,    null, 2));
  zip.file('nmapScans.json',     JSON.stringify(data.nmapScans,     null, 2));
  zip.file('nmapMachines.json',  JSON.stringify(data.nmapMachines,  null, 2));
  zip.file('pageSnapshots.json', JSON.stringify(data.pageSnapshots, null, 2));
  zip.file('siteMaps.json',      JSON.stringify(data.siteMaps,      null, 2));
  zip.file('siteMapNodes.json',  JSON.stringify(data.siteMapNodes,  null, 2));
  zip.file('siteMapEdges.json',  JSON.stringify(data.siteMapEdges,  null, 2));

  // Human-readable companion outputs (markdown + GraphML) preserved from v1.
  const pagesFolder = zip.folder('pages')!;
  for (const page of data.pages) {
    const safe = page.title.replace(/[/\\?%*:|"<>]/g, '_') || page.id;
    pagesFolder.file(`${safe}.md`, pageToMarkdown(page));
  }
  const graphsFolder = zip.folder('graphs')!;
  for (const graph of data.graphs) {
    const nodes = data.graphNodes.filter((n) => n.graphId === graph.id);
    const edges = data.graphEdges.filter((e) => e.graphId === graph.id);
    const safe = graph.name.replace(/[/\\?%*:|"<>]/g, '_') || graph.id;
    graphsFolder.file(`${safe}.graphml`, toGraphML(nodes, edges, graph.name));
  }

  // Raw Yjs binary updates per page: base64 inside JSON so the zip
  // remains text-friendly. Skipped when no doc was reachable.
  zip.file('pageYjsUpdates.json', JSON.stringify(data.pageYjsUpdates, null, 2));

  return zip.generateAsync({ type: 'blob' });
}

/**
 * Capture the live Y.Doc state for a list of pages. Best-effort: returns
 * an empty record if the page docs aren't reachable in this session.
 */
export function collectPageYjsUpdates(pageIds: ID[]): Record<ID, string> {
  const out: Record<ID, string> = {};
  for (const pageId of pageIds) {
    try {
      const ctx = getPageYContext(pageId);
      const bytes = Y.encodeStateAsUpdate(ctx.doc);
      if (bytes.byteLength > 0) {
        out[pageId] = bytesToBase64(bytes);
      }
    } catch {
      // ignore; per-page docs only exist after they're opened at least once
    }
  }
  return out;
}

/**
 * Import workspace from a zip file. Reads both v2 (this file's current
 * format) and the legacy v1 layout for backward compat.
 */
export async function parseWorkspaceZip(blob: Blob): Promise<WorkspaceExportData> {
  const zip = await JSZip.loadAsync(blob);
  const wsJson = await zip.file('workspace.json')?.async('string');
  if (!wsJson) throw new Error('Invalid workspace zip: missing workspace.json');
  const workspace = JSON.parse(wsJson) as Workspace;

  // v2 prefers flat top-level entity JSONs; v1 used pages/_index.json etc.
  const readJson = async <T>(name: string, legacy?: string): Promise<T[]> => {
    const flat = await zip.file(name)?.async('string');
    if (flat) return JSON.parse(flat) as T[];
    if (legacy) {
      const old = await zip.file(legacy)?.async('string');
      if (old) return JSON.parse(old) as T[];
    }
    return [];
  };

  const pages         = await readJson<Page>        ('pages.json',         'pages/_index.json');
  const graphs        = await readJson<Graph>       ('graphs.json',        'graphs/_index.json');
  let   graphNodes    = await readJson<GraphNode>   ('graphNodes.json');
  let   graphEdges    = await readJson<GraphEdge>   ('graphEdges.json');
  const attackChains  = await readJson<AttackChain> ('attackChains.json');
  const changeLogs    = await readJson<ChangeLogEntry>('changeLogs.json');
  const nmapScans     = await readJson<NmapScan>    ('nmapScans.json');
  const nmapMachines  = await readJson<NmapMachine> ('nmapMachines.json');
  const pageSnapshots = await readJson<PageSnapshot>('pageSnapshots.json');
  const siteMaps      = await readJson<SiteMap>     ('siteMaps.json');
  const siteMapNodes  = await readJson<SiteMapNode> ('siteMapNodes.json');
  const siteMapEdges  = await readJson<SiteMapEdge> ('siteMapEdges.json');

  // v1 fallback: per-graph node/edge JSONs split by folder
  if (graphNodes.length === 0 && graphEdges.length === 0) {
    for (const graph of graphs) {
      const n = await zip.file(`graphs/${graph.id}/nodes.json`)?.async('string');
      const e = await zip.file(`graphs/${graph.id}/edges.json`)?.async('string');
      if (n) graphNodes = graphNodes.concat(JSON.parse(n) as GraphNode[]);
      if (e) graphEdges = graphEdges.concat(JSON.parse(e) as GraphEdge[]);
    }
  }

  let pageYjsUpdates: Record<ID, string> = {};
  const yjsJson = await zip.file('pageYjsUpdates.json')?.async('string');
  if (yjsJson) {
    try { pageYjsUpdates = JSON.parse(yjsJson) as Record<ID, string>; } catch { /* ignore */ }
  }

  return {
    schemaVersion: 2,
    exportedAt: Date.now(),
    workspace,
    pages,
    graphs,
    graphNodes,
    graphEdges,
    attackChains,
    changeLogs,
    nmapScans,
    nmapMachines,
    pageSnapshots,
    siteMaps,
    siteMapNodes,
    siteMapEdges,
    pageYjsUpdates,
  };
}

/**
 * Apply a previously-captured Y.Doc binary update to a live page Y.Doc.
 * Use after importing the page records, so collab history and formatting
 * marks come back too. CRDT merge: applying the snapshot to a fresh doc
 * is a clean restore; applying to a doc that already has remote state
 * merges them.
 */
export function applyImportedPageYjsUpdate(pageId: string, updateBase64: string): void {
  const ctx = getPageYContext(pageId);
  const bytes = base64ToBytes(updateBase64);
  Y.applyUpdate(ctx.doc, bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
