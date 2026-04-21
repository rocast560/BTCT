import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import type { Workspace } from '@/types';

export const workspaceRepo = {
  async getAll(): Promise<Workspace[]> {
    return db.workspaces.toArray();
  },

  async getById(id: string): Promise<Workspace | undefined> {
    return db.workspaces.get(id);
  },

  async create(data: Pick<Workspace, 'name' | 'description'>): Promise<Workspace> {
    const now = Date.now();
    const workspace: Workspace = {
      id: uuidv4(),
      name: data.name,
      description: data.description,
      createdAt: now,
      updatedAt: now,
    };
    await db.workspaces.add(workspace);
    return workspace;
  },

  async update(id: string, data: Partial<Pick<Workspace, 'name' | 'description'>>): Promise<void> {
    await db.workspaces.update(id, { ...data, updatedAt: Date.now() });
  },

  async remove(id: string): Promise<void> {
    await db.transaction('rw', [db.workspaces, db.pages, db.graphs, db.graphNodes, db.graphEdges], async () => {
      const graphs = await db.graphs.where('workspaceId').equals(id).toArray();
      for (const graph of graphs) {
        await db.graphEdges.where('graphId').equals(graph.id).delete();
        await db.graphNodes.where('graphId').equals(graph.id).delete();
      }
      await db.graphs.where('workspaceId').equals(id).delete();
      await db.pages.where('workspaceId').equals(id).delete();
      await db.workspaces.delete(id);
    });
  },
};
