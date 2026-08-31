/**
 * Repo for user-added Attack Timeline events. These are the "custom events" a
 * user quick-adds (Ctrl/⌘+Shift+E): a typed, timestamped entry that shows on
 * the timeline next to the graph-derived events, flagged with who added it.
 *
 * Like `typstAssets` / `commandLogs` these records have no Y.Text fields (a
 * quick-added title is not co-typed), so they stay plain last-writer-wins JSON
 * and the Y.Text pre-seeding invariant (#1) doesn't apply.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import type { CustomTimelineEvent, ID, NodeType } from '@/types';

export const timelineEventRepo = {
  async getByWorkspace(workspaceId: ID): Promise<CustomTimelineEvent[]> {
    const all = await db.timelineEvents.where('workspaceId').equals(workspaceId).toArray();
    return all.sort((a, b) => a.timestamp - b.timestamp);
  },

  async create(data: {
    workspaceId: ID;
    kind: NodeType;
    title: string;
    details: string;
    timestamp: number;
    createdBy: number | null;
    createdByName: string;
  }): Promise<CustomTimelineEvent> {
    const now = Date.now();
    const event: CustomTimelineEvent = {
      id: uuidv4(),
      workspaceId: data.workspaceId,
      kind: data.kind,
      title: data.title.trim() || 'Untitled event',
      details: data.details.trim(),
      timestamp: data.timestamp,
      createdBy: data.createdBy,
      createdByName: data.createdByName,
      createdAt: now,
      updatedAt: now,
    };
    await db.timelineEvents.add(event);
    return event;
  },

  async remove(id: ID): Promise<void> {
    await db.timelineEvents.delete(id);
  },
};
