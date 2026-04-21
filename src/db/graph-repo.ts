import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import type { Graph } from '@/types';

export const graphRepo = {
  async getByWorkspace(workspaceId: string): Promise<Graph[]> {
    return db.graphs.where('workspaceId').equals(workspaceId).toArray();
  },

  async getById(id: string): Promise<Graph | undefined> {
    return db.graphs.get(id);
  },

  async create(data: Pick<Graph, 'workspaceId' | 'name'>): Promise<Graph> {
    const now = Date.now();
    const graph: Graph = {
      id: uuidv4(),
      workspaceId: data.workspaceId,
      name: data.name,
      createdAt: now,
      updatedAt: now,
    };
    await db.graphs.add(graph);
    return graph;
  },

  async update(id: string, data: Partial<Pick<Graph, 'name'>>): Promise<void> {
    await db.graphs.update(id, { ...data, updatedAt: Date.now() });
  },

  async remove(id: string): Promise<void> {
    await db.transaction('rw', [db.graphs, db.graphNodes, db.graphEdges, db.pages], async () => {
      // Delete linked graph pages
      const nodes = await db.graphNodes.where('graphId').equals(id).toArray();
      for (const node of nodes) {
        if (node.linkedPageId) {
          await db.pages.delete(node.linkedPageId);
        }
      }
      await db.graphEdges.where('graphId').equals(id).delete();
      await db.graphNodes.where('graphId').equals(id).delete();
      await db.graphs.delete(id);
    });
  },
};
