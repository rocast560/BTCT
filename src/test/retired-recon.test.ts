import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
vi.mock('@/realtime/shared-doc', () => ({ getSharedDoc: vi.fn() }));
import { getSharedDoc } from '@/realtime/shared-doc';
import { collectRetiredRecon, restoreRetiredRecon } from '@/export/retired-recon';

let doc: Y.Doc;
beforeEach(() => {
  doc = new Y.Doc();
  vi.mocked(getSharedDoc).mockReturnValue({ doc } as ReturnType<typeof getSharedDoc>);
});
describe('retired recon archive compatibility', () => {
  it('exports only records belonging to the selected workspace', () => {
    doc.getMap('siteMaps').set('map-a', { id: 'map-a', workspaceId: 'a' });
    doc.getMap('siteMaps').set('map-b', { id: 'map-b', workspaceId: 'b' });
    doc.getMap('siteMapNodes').set('node-a', { id: 'node-a', siteMapId: 'map-a', notes: 'preserved' });
    doc.getMap('siteMapNodes').set('node-b', { id: 'node-b', siteMapId: 'map-b' });
    const data = collectRetiredRecon('a');
    expect(data.siteMaps.map((r) => r.id)).toEqual(['map-a']);
    expect(data.siteMapNodes.map((r) => r.id)).toEqual(['node-a']);
  });
  it('remaps archived relationships when importing a copy', () => {
    restoreRetiredRecon({
      siteMaps: [{ id: 'map', workspaceId: 'old' }],
      siteMapNodes: [{ id: 'node', siteMapId: 'map', notes: 'preserved' }],
      siteMapEdges: [{ id: 'edge', siteMapId: 'map', sourceNodeId: 'node', targetNodeId: 'node' }],
    }, 'new', (id) => `copy-${id}`);
    expect(collectRetiredRecon('new')).toEqual({
      siteMaps: [{ id: 'copy-map', workspaceId: 'new' }],
      siteMapNodes: [{ id: 'copy-node', siteMapId: 'copy-map', notes: 'preserved' }],
      siteMapEdges: [{ id: 'copy-edge', siteMapId: 'copy-map', sourceNodeId: 'copy-node', targetNodeId: 'copy-node' }],
    });
  });
});
