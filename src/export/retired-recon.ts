import { getSharedDoc } from '@/realtime/shared-doc';

/** Archive compatibility only. No scanner, UI, observers, or active recon store. */
export interface RetiredRecord {
  id: string;
  workspaceId?: string;
  siteMapId?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  [key: string]: unknown;
}
export interface RetiredRecon {
  siteMaps: RetiredRecord[];
  siteMapNodes: RetiredRecord[];
  siteMapEdges: RetiredRecord[];
}
export function collectRetiredRecon(workspaceId: string): RetiredRecon {
  const { doc } = getSharedDoc();
  const siteMaps = [...doc.getMap<RetiredRecord>('siteMaps').values()].filter((r) => r.workspaceId === workspaceId);
  const ids = new Set(siteMaps.map((r) => r.id));
  return {
    siteMaps,
    siteMapNodes: [...doc.getMap<RetiredRecord>('siteMapNodes').values()].filter((r) => ids.has(r.siteMapId ?? '')),
    siteMapEdges: [...doc.getMap<RetiredRecord>('siteMapEdges').values()].filter((r) => ids.has(r.siteMapId ?? '')),
  };
}
export function restoreRetiredRecon(data: RetiredRecon | undefined, workspaceId: string, remap: (id: string) => string): void {
  if (!data) return;
  const { doc } = getSharedDoc();
  doc.transact(() => {
    for (const key of ['siteMaps', 'siteMapNodes', 'siteMapEdges'] as const) {
      const table = doc.getMap<RetiredRecord>(key);
      for (const record of data[key]) {
        const copy = { ...record, id: remap(record.id) };
        if (key === 'siteMaps') copy.workspaceId = workspaceId;
        for (const field of ['siteMapId', 'sourceNodeId', 'targetNodeId'] as const) {
          if (typeof record[field] === 'string') copy[field] = remap(record[field]);
        }
        table.set(copy.id, copy);
      }
    }
  });
}
