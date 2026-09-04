import { db } from './database';
import type { SiteMap, SiteMapNode, SiteMapEdge, ID } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { getOrInitYText, setYTextValue, textKey, sharedTransact } from '@/realtime/shared-doc';
import type { SiteNodeInput, SiteEdgeInput } from '@/lib/sitemap-parser';

// Lay new nodes out on a loose grid so an import isn't a pile at the origin
// before the user (or the first-import auto-layout) arranges them.
function gridPosition(index: number): { x: number; y: number } {
  return { x: 120 + (index % 8) * 220, y: 120 + Math.floor(index / 8) * 130 };
}

export const siteMapRepo = {
  async create(workspaceId: ID, name: string, rootUrl = ''): Promise<SiteMap> {
    const now = Date.now();
    const map: SiteMap = {
      id: uuidv4(),
      workspaceId,
      name,
      rootUrl,
      createdAt: now,
      updatedAt: now,
      lastScanAt: null,
    };
    await db.siteMaps.add(map);
    // Pre-seed the collaborative name Y.Text (invariant #1).
    getOrInitYText(textKey('siteMap', map.id, 'name'), map.name);
    return map;
  },

  async getByWorkspace(workspaceId: ID): Promise<SiteMap[]> {
    return db.siteMaps.where('workspaceId').equals(workspaceId).reverse().sortBy('createdAt');
  },

  async getById(id: ID): Promise<SiteMap | undefined> {
    return db.siteMaps.get(id);
  },

  async rename(id: ID, name: string): Promise<void> {
    await db.siteMaps.update(id, { name, updatedAt: Date.now() });
    // `name` is a collaborative Y.Text: update it too or the mirror reverts
    // the record on the next sync (invariant #2).
    setYTextValue('siteMap', id, 'name', name);
  },

  async setMeta(id: ID, patch: Partial<Pick<SiteMap, 'rootUrl' | 'lastScanAt'>>): Promise<void> {
    await db.siteMaps.update(id, { ...patch, updatedAt: Date.now() });
  },

  async delete(id: ID): Promise<void> {
    await db.siteMapNodes.where('siteMapId').equals(id).delete();
    await db.siteMapEdges.where('siteMapId').equals(id).delete();
    await db.siteMaps.delete(id);
  },
};

export interface UpsertNodesResult {
  /** Node key -> record id, for every node now in the map (added + existing). */
  idByKey: Map<string, ID>;
  addedIds: ID[];
  /** How many nodes the map had before this upsert (0 = first import). */
  prevCount: number;
}

export const siteMapNodeRepo = {
  async getBySiteMap(siteMapId: ID): Promise<SiteMapNode[]> {
    return db.siteMapNodes.where('siteMapId').equals(siteMapId).toArray();
  },

  /** Upsert nodes by their natural `key`. Existing nodes merge (list fields
   *  union, notes/position/discoveredAt preserved); new nodes get a grid slot. */
  async upsertByKey(siteMapId: ID, inputs: SiteNodeInput[]): Promise<UpsertNodesResult> {
    const existing = await db.siteMapNodes.where('siteMapId').equals(siteMapId).toArray();
    const byKey = new Map(existing.map((n) => [n.key, n]));
    const now = Date.now();
    const idByKey = new Map<string, ID>();
    const toAdd: SiteMapNode[] = [];
    const toUpdate: { id: ID; data: Partial<SiteMapNode> }[] = [];
    const prevCount = existing.length;

    for (const inp of inputs) {
      const ex = byKey.get(inp.key);
      if (ex) {
        idByKey.set(inp.key, ex.id);
        toUpdate.push({
          id: ex.id,
          data: {
            url: inp.url || ex.url,
            method: inp.method || ex.method,
            status: inp.status ?? ex.status,
            contentType: inp.contentType || ex.contentType,
            title: inp.title || ex.title,
            size: inp.size ?? ex.size,
            params: unionList(ex.params, inp.params),
            sources: unionList(ex.sources, inp.sources),
            tags: unionList(ex.tags, inp.tags),
            updatedAt: now,
          },
        });
      } else {
        const id = uuidv4();
        idByKey.set(inp.key, id);
        toAdd.push({
          id,
          siteMapId,
          key: inp.key,
          type: inp.type,
          url: inp.url,
          method: inp.method,
          status: inp.status,
          contentType: inp.contentType,
          title: inp.title,
          size: inp.size,
          params: inp.params,
          sources: inp.sources,
          tags: inp.tags,
          notes: inp.notes,
          position: gridPosition(prevCount + toAdd.length),
          discoveredAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // One transaction so peers receive a single update for the whole import.
    sharedTransact(() => {
      for (const r of toAdd) void db.siteMapNodes.add(r);
      for (const u of toUpdate) void db.siteMapNodes.update(u.id, u.data);
    });

    return { idByKey, addedIds: toAdd.map((n) => n.id), prevCount };
  },

  async update(id: ID, data: Partial<Pick<SiteMapNode, 'notes' | 'tags' | 'title' | 'position'>>): Promise<void> {
    await db.siteMapNodes.update(id, { ...data, updatedAt: Date.now() });
  },

  /** Persist a batch of dragged/laid-out positions in one Yjs transaction. */
  async updatePositions(updates: { id: ID; position: { x: number; y: number } }[]): Promise<void> {
    if (updates.length === 0) return;
    sharedTransact(() => {
      for (const u of updates) void db.siteMapNodes.update(u.id, { position: u.position });
    });
  },

  async delete(id: ID): Promise<void> {
    // Drop edges touching this node, then the node.
    const edges = await db.siteMapEdges.toArray();
    sharedTransact(() => {
      for (const e of edges) {
        if (e.sourceNodeId === id || e.targetNodeId === id) void db.siteMapEdges.delete(e.id);
      }
      void db.siteMapNodes.delete(id);
    });
  },
};

export const siteMapEdgeRepo = {
  async getBySiteMap(siteMapId: ID): Promise<SiteMapEdge[]> {
    return db.siteMapEdges.where('siteMapId').equals(siteMapId).toArray();
  },

  /** Add edges (resolving node keys to ids); dedupe by source|target|kind. */
  async upsertEdges(siteMapId: ID, inputs: SiteEdgeInput[], idByKey: Map<string, ID>): Promise<ID[]> {
    const existing = await db.siteMapEdges.where('siteMapId').equals(siteMapId).toArray();
    const seen = new Set(existing.map((e) => `${e.sourceNodeId}|${e.targetNodeId}|${e.kind}`));
    const now = Date.now();
    const toAdd: SiteMapEdge[] = [];
    for (const inp of inputs) {
      const src = idByKey.get(inp.source);
      const tgt = idByKey.get(inp.target);
      if (!src || !tgt || src === tgt) continue;
      const dedupe = `${src}|${tgt}|${inp.kind}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      toAdd.push({
        id: uuidv4(),
        siteMapId,
        sourceNodeId: src,
        targetNodeId: tgt,
        kind: inp.kind,
        label: inp.label,
        createdAt: now,
        updatedAt: now,
      });
    }
    sharedTransact(() => {
      for (const e of toAdd) void db.siteMapEdges.add(e);
    });
    return toAdd.map((e) => e.id);
  },

  async delete(id: ID): Promise<void> {
    await db.siteMapEdges.delete(id);
  },
};

function unionList(a: string[], b: string[]): string[] {
  if (!b.length) return a;
  const out = [...a];
  const seen = new Set(a);
  for (const x of b) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= 64) break;
  }
  return out;
}
