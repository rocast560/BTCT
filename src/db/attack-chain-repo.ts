import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import type { AttackChain, ID } from '@/types';

export const attackChainRepo = {
  async getByWorkspace(workspaceId: ID): Promise<AttackChain[]> {
    return db.attackChains.where('workspaceId').equals(workspaceId).toArray();
  },

  async getByGraph(graphId: ID): Promise<AttackChain[]> {
    return db.attackChains.where('graphId').equals(graphId).toArray();
  },

  async create(data: { workspaceId: ID; graphId: ID; name: string; nodeIds: ID[] }): Promise<AttackChain> {
    const now = Date.now();
    const chain: AttackChain = {
      id: uuidv4(),
      workspaceId: data.workspaceId,
      graphId: data.graphId,
      name: data.name,
      nodeIds: data.nodeIds,
      createdAt: now,
      updatedAt: now,
    };
    await db.attackChains.add(chain);
    return chain;
  },

  async update(id: ID, data: Partial<Pick<AttackChain, 'name' | 'nodeIds'>>): Promise<void> {
    await db.attackChains.update(id, { ...data, updatedAt: Date.now() });
  },

  async remove(id: ID): Promise<void> {
    await db.attackChains.delete(id);
  },
};
