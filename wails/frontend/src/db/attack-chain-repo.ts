import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import { pageRepo } from './page-repo';
import { getOrInitYText, setYTextValue, textKey } from '@/realtime/shared-doc';
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
    // Auto-create a hidden writeup page for the chain.
    const page = await pageRepo.create({
      workspaceId: data.workspaceId,
      parentId: null,
      title: data.name,
      icon: '',
      isGraphPage: true,
    });
    const chain: AttackChain = {
      id: uuidv4(),
      workspaceId: data.workspaceId,
      graphId: data.graphId,
      name: data.name,
      nodeIds: data.nodeIds,
      linkedPageId: page.id,
      createdAt: now,
      updatedAt: now,
    };
    await db.attackChains.add(chain);
    getOrInitYText(textKey('attackChain', chain.id, 'name'), chain.name); // invariant #1
    return chain;
  },

  async update(id: ID, data: Partial<Pick<AttackChain, 'name' | 'nodeIds' | 'linkedPageId'>>): Promise<void> {
    await db.attackChains.update(id, { ...data, updatedAt: Date.now() });
    // `name` is a collaborative Y.Text — keep it in sync (invariant #2).
    if (data.name !== undefined) setYTextValue('attackChain', id, 'name', data.name);
  },

  async remove(id: ID): Promise<void> {
    const chain = await db.attackChains.get(id);
    if (chain?.linkedPageId) {
      await db.pages.delete(chain.linkedPageId);
    }
    await db.attackChains.delete(id);
  },

  // Lazily creates a writeup page for chains created before linkedPageId
  // existed. Returns the page id (newly minted or pre-existing).
  async ensurePage(id: ID): Promise<ID | null> {
    const chain = await db.attackChains.get(id);
    if (!chain) return null;
    if (chain.linkedPageId) return chain.linkedPageId;
    const page = await pageRepo.create({
      workspaceId: chain.workspaceId,
      parentId: null,
      title: chain.name,
      icon: '',
      isGraphPage: true,
    });
    await db.attackChains.update(id, { linkedPageId: page.id, updatedAt: Date.now() });
    return page.id;
  },
};
