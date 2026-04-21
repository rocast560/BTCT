import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import type { GraphEdge, EdgeType } from '@/types';

export const graphEdgeRepo = {
  async getByGraph(graphId: string): Promise<GraphEdge[]> {
    return db.graphEdges.where('graphId').equals(graphId).toArray();
  },

  async getById(id: string): Promise<GraphEdge | undefined> {
    return db.graphEdges.get(id);
  },

  async create(data: {
    graphId: string;
    sourceNodeId: string;
    targetNodeId: string;
    edgeType: EdgeType;
    label?: string;
  }): Promise<GraphEdge> {
    const now = Date.now();
    const edge: GraphEdge = {
      id: uuidv4(),
      graphId: data.graphId,
      sourceNodeId: data.sourceNodeId,
      targetNodeId: data.targetNodeId,
      edgeType: data.edgeType,
      label: data.label ?? data.edgeType,
      linkedPageId: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.graphEdges.add(edge);
    return edge;
  },

  async update(id: string, data: Partial<Omit<GraphEdge, 'id' | 'graphId' | 'createdAt'>>): Promise<void> {
    await db.graphEdges.update(id, { ...data, updatedAt: Date.now() });
  },

  async remove(id: string): Promise<void> {
    await db.graphEdges.delete(id);
  },
};
