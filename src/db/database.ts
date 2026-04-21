import Dexie, { type EntityTable } from 'dexie';
import type { Workspace, Page, Graph, GraphNode, GraphEdge, ChangeLogEntry, NmapScan, NmapMachine, AttackChain } from '@/types';

export class AppDatabase extends Dexie {
  workspaces!: EntityTable<Workspace, 'id'>;
  pages!: EntityTable<Page, 'id'>;
  graphs!: EntityTable<Graph, 'id'>;
  graphNodes!: EntityTable<GraphNode, 'id'>;
  graphEdges!: EntityTable<GraphEdge, 'id'>;
  changeLogs!: EntityTable<ChangeLogEntry, 'id'>;
  nmapScans!: EntityTable<NmapScan, 'id'>;
  nmapMachines!: EntityTable<NmapMachine, 'id'>;
  attackChains!: EntityTable<AttackChain, 'id'>;

  constructor() {
    super('WebNoteAppDB');
    this.version(1).stores({
      workspaces: 'id, name',
      pages: 'id, workspaceId, parentId, *tags, updatedAt',
      graphs: 'id, workspaceId',
      graphNodes: 'id, graphId, type, linkedPageId, discoveredAt',
      graphEdges: 'id, graphId, sourceNodeId, targetNodeId, linkedPageId',
    });
    this.version(2).stores({
      workspaces: 'id, name',
      pages: 'id, workspaceId, parentId, *tags, updatedAt',
      graphs: 'id, workspaceId',
      graphNodes: 'id, graphId, type, linkedPageId, discoveredAt',
      graphEdges: 'id, graphId, sourceNodeId, targetNodeId, linkedPageId',
      changeLogs: 'id, workspaceId, timestamp',
    });
    this.version(3).stores({
      workspaces: 'id, name',
      pages: 'id, workspaceId, parentId, *tags, updatedAt',
      graphs: 'id, workspaceId',
      graphNodes: 'id, graphId, type, linkedPageId, discoveredAt',
      graphEdges: 'id, graphId, sourceNodeId, targetNodeId, linkedPageId',
      changeLogs: 'id, workspaceId, timestamp',
      nmapScans: 'id, workspaceId, importedAt',
      nmapMachines: 'id, scanId, ip',
    });
    this.version(4).stores({
      workspaces: 'id, name',
      pages: 'id, workspaceId, parentId, *tags, updatedAt',
      graphs: 'id, workspaceId',
      graphNodes: 'id, graphId, type, linkedPageId, discoveredAt',
      graphEdges: 'id, graphId, sourceNodeId, targetNodeId, linkedPageId',
      changeLogs: 'id, workspaceId, timestamp',
      nmapScans: 'id, workspaceId, importedAt',
      nmapMachines: 'id, scanId, ip, linkedNodeId',
    });
    this.version(5).stores({
      workspaces: 'id, name',
      pages: 'id, workspaceId, parentId, *tags, updatedAt',
      graphs: 'id, workspaceId',
      graphNodes: 'id, graphId, type, linkedPageId, discoveredAt',
      graphEdges: 'id, graphId, sourceNodeId, targetNodeId, linkedPageId',
      changeLogs: 'id, workspaceId, timestamp',
      nmapScans: 'id, workspaceId, importedAt',
      nmapMachines: 'id, scanId, ip, linkedNodeId',
      attackChains: 'id, workspaceId, graphId, updatedAt',
    });
  }
}

export const db = new AppDatabase();
