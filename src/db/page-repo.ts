import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import type { Page, PartialBlockContent } from '@/types';

export const pageRepo = {
  async getByWorkspace(workspaceId: string, includeGraphPages = false): Promise<Page[]> {
    const pages = await db.pages.where('workspaceId').equals(workspaceId).toArray();
    if (includeGraphPages) return pages;
    return pages.filter((p) => !p.isGraphPage);
  },

  async getById(id: string): Promise<Page | undefined> {
    return db.pages.get(id);
  },

  async getChildren(parentId: string): Promise<Page[]> {
    return db.pages.where('parentId').equals(parentId).sortBy('sortOrder');
  },

  async getByTag(workspaceId: string, tag: string): Promise<Page[]> {
    return db.pages
      .where('workspaceId')
      .equals(workspaceId)
      .and((p) => p.tags.includes(tag))
      .toArray();
  },

  async getBacklinks(pageId: string): Promise<{ nodes: import('@/types').GraphNode[]; edges: import('@/types').GraphEdge[] }> {
    const [nodes, edges] = await Promise.all([
      db.graphNodes.where('linkedPageId').equals(pageId).toArray(),
      db.graphEdges.where('linkedPageId').equals(pageId).toArray(),
    ]);
    return { nodes, edges };
  },

  async create(data: {
    workspaceId: string;
    parentId: string | null;
    title: string;
    slug?: string;
    icon?: string;
    tags?: string[];
    content?: PartialBlockContent;
    isGraphPage?: boolean;
    sortOrder?: number;
  }): Promise<Page> {
    const now = Date.now();
    const siblings = data.parentId
      ? await db.pages.where('parentId').equals(data.parentId).count()
      : await db.pages
          .where('workspaceId')
          .equals(data.workspaceId)
          .and((p) => p.parentId === null && !p.isGraphPage)
          .count();

    const page: Page = {
      id: uuidv4(),
      workspaceId: data.workspaceId,
      parentId: data.parentId,
      title: data.title,
      slug: data.slug ?? data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      icon: data.icon ?? '📄',
      tags: data.tags ?? [],
      content: data.content ?? [],
      sortOrder: data.sortOrder ?? siblings,
      isGraphPage: data.isGraphPage ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await db.pages.add(page);
    return page;
  },

  async update(id: string, data: Partial<Omit<Page, 'id' | 'workspaceId' | 'createdAt'>>): Promise<void> {
    await db.pages.update(id, { ...data, updatedAt: Date.now() });
  },

  async remove(id: string): Promise<void> {
    // Recursively delete children
    const children = await db.pages.where('parentId').equals(id).toArray();
    for (const child of children) {
      await this.remove(child.id);
    }
    await db.pages.delete(id);
  },

  async search(workspaceId: string, query: string): Promise<Page[]> {
    const lower = query.toLowerCase();
    return db.pages
      .where('workspaceId')
      .equals(workspaceId)
      .and((p) => p.title.toLowerCase().includes(lower) || p.tags.some((t) => t.toLowerCase().includes(lower)))
      .toArray();
  },
};
