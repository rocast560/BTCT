import { RETIRED_TABLES, emptyRetired, type RetiredData, type RetiredRecord } from './retired';
import JSZip from 'jszip';
import * as Y from 'yjs';
import type {
  Workspace, Page, ChangeLogEntry, NmapScan, NmapMachine, PageSnapshot,
} from '@/types';
import { pageToMarkdown } from './markdown';
import { getPageYContext, withPageYContext } from '@/realtime/yjs-providers';

/**
 * Lossless workspace export: every entity table tied to the workspace
 * plus the raw Yjs binary update of every page body (for roundtrip
 * fidelity of collab history, formatting marks, embedded blocks).
 *
 * Backwards-compatible: the importer reads the legacy v1 layout as well
 * (workspace + pages + graphs/nodes/edges), so older zips still load. The
 * tables behind removed features ride along in `retired` (see ./retired),
 * so a ZIP written here is still a full archive of what earlier builds
 * stored.
 */
export interface WorkspaceExportData {
  retired?: RetiredData;
  schemaVersion: 2;
  exportedAt: number;
  workspace: Workspace;
  pages: Page[];
  changeLogs: ChangeLogEntry[];
  nmapScans: NmapScan[];
  nmapMachines: NmapMachine[];
  pageSnapshots: PageSnapshot[];
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
      changeLogs: data.changeLogs.length,
      nmapScans: data.nmapScans.length,
      nmapMachines: data.nmapMachines.length,
      pageSnapshots: data.pageSnapshots.length,
      pageYjsUpdates: Object.keys(data.pageYjsUpdates).length,
      retired: Object.fromEntries(RETIRED_TABLES.map((t) => [t, data.retired?.[t].length ?? 0])),
    },
  }, null, 2));

  zip.file('workspace.json',     JSON.stringify(data.workspace,     null, 2));
  zip.file('pages.json',         JSON.stringify(data.pages,         null, 2));
  zip.file('changeLogs.json',    JSON.stringify(data.changeLogs,    null, 2));
  zip.file('nmapScans.json',     JSON.stringify(data.nmapScans,     null, 2));
  zip.file('nmapMachines.json',  JSON.stringify(data.nmapMachines,  null, 2));
  zip.file('pageSnapshots.json', JSON.stringify(data.pageSnapshots, null, 2));

  // Retired-feature tables keep their original top-level filenames, so a
  // zip from this build still imports into an older one.
  for (const key of RETIRED_TABLES) {
    if (data.retired?.[key].length) zip.file(`${key}.json`, JSON.stringify(data.retired[key]));
  }

  // Human-readable companion output (markdown) preserved from v1.
  const pagesFolder = zip.folder('pages')!;
  for (const page of data.pages) {
    const safe = page.title.replace(/[/\\?%*:|"<>]/g, '_') || page.id;
    pagesFolder.file(`${safe}.md`, pageToMarkdown(page));
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
export async function collectPageYjsUpdates(pageIds: ID[]): Promise<Record<ID, string>> {
  const out: Record<ID, string> = {};
  for (let i = 0; i < pageIds.length; i += 4) {
    await Promise.all(pageIds.slice(i, i + 4).map((pageId) => withPageYContext(pageId, async (ctx) => {
      await ctx.whenFullySynced;
      out[pageId] = bytesToBase64(Y.encodeStateAsUpdate(ctx.doc));
    })));
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
  const changeLogs    = await readJson<ChangeLogEntry>('changeLogs.json');
  const nmapScans     = await readJson<NmapScan>    ('nmapScans.json');
  const nmapMachines  = await readJson<NmapMachine> ('nmapMachines.json');
  const pageSnapshots = await readJson<PageSnapshot>('pageSnapshots.json');

  const retired: RetiredData = emptyRetired();
  for (const key of RETIRED_TABLES) {
    retired[key] = await readJson<RetiredRecord>(`${key}.json`, key === 'graphs' ? 'graphs/_index.json' : undefined);
  }

  // v1 fallback: per-graph node/edge JSONs split by folder.
  if (retired.graphNodes.length === 0 && retired.graphEdges.length === 0) {
    for (const graph of retired.graphs) {
      const n = await zip.file(`graphs/${graph.id}/nodes.json`)?.async('string');
      const e = await zip.file(`graphs/${graph.id}/edges.json`)?.async('string');
      if (n) retired.graphNodes = retired.graphNodes.concat(JSON.parse(n) as RetiredRecord[]);
      if (e) retired.graphEdges = retired.graphEdges.concat(JSON.parse(e) as RetiredRecord[]);
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
    changeLogs,
    nmapScans,
    nmapMachines,
    pageSnapshots,
    pageYjsUpdates,
    retired,
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
