import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import { pageRepo } from './page-repo';
import type { GraphNode, NodeType, AnyNodeData } from '@/types';
import { defaultNodeData } from '@/types';

export const graphNodeRepo = {
  async getByGraph(graphId: string): Promise<GraphNode[]> {
    return db.graphNodes.where('graphId').equals(graphId).toArray();
  },

  async getAllByType(type: NodeType): Promise<GraphNode[]> {
    return db.graphNodes.where('type').equals(type).toArray();
  },

  async getById(id: string): Promise<GraphNode | undefined> {
    return db.graphNodes.get(id);
  },

  async getByLinkedPage(pageId: string): Promise<GraphNode[]> {
    return db.graphNodes.where('linkedPageId').equals(pageId).toArray();
  },

  async create(data: {
    graphId: string;
    type: NodeType;
    label: string;
    position: { x: number; y: number };
    data?: AnyNodeData;
    workspaceId: string;
  }): Promise<GraphNode> {
    const now = Date.now();

    // Auto-create linked page
    const page = await pageRepo.create({
      workspaceId: data.workspaceId,
      parentId: null,
      title: data.label,
      icon: nodeTypeIcon(data.type),
      isGraphPage: true,
    });

    const node: GraphNode = {
      id: uuidv4(),
      graphId: data.graphId,
      type: data.type,
      label: data.label,
      position: data.position,
      data: data.data ?? defaultNodeData(data.type),
      linkedPageId: page.id,
      discoveredAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await db.graphNodes.add(node);
    return node;
  },

  async update(id: string, data: Partial<Omit<GraphNode, 'id' | 'graphId' | 'createdAt'>>): Promise<void> {
    await db.graphNodes.update(id, { ...data, updatedAt: Date.now() });
  },

  async remove(id: string): Promise<void> {
    const node = await db.graphNodes.get(id);
    if (node) {
      // Remove linked page
      await db.pages.delete(node.linkedPageId);
      // Remove connected edges
      await db.graphEdges.where('sourceNodeId').equals(id).delete();
      await db.graphEdges.where('targetNodeId').equals(id).delete();
      await db.graphNodes.delete(id);
    }
  },
};

function nodeTypeIcon(type: NodeType): string {
  switch (type) {
    case 'host': return '🖥️';
    case 'credential': return '🔑';
    case 'service': return '⚙️';
    case 'finding': return '🐛';
    case 'pivot': return '🔄';
  }
}
