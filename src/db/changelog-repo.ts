import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import type { ChangeAction, ChangeTarget, ChangeLogEntry } from '@/types';

export const changeLogRepo = {
  async add(workspaceId: string, action: ChangeAction, target: ChangeTarget, targetId: string, summary: string): Promise<ChangeLogEntry> {
    const entry: ChangeLogEntry = {
      id: uuidv4(),
      workspaceId,
      action,
      target,
      targetId,
      summary,
      timestamp: Date.now(),
    };
    await db.changeLogs.add(entry);
    return entry;
  },

  async getByWorkspace(workspaceId: string, limit = 100): Promise<ChangeLogEntry[]> {
    return db.changeLogs
      .where('workspaceId')
      .equals(workspaceId)
      .reverse()
      .sortBy('timestamp')
      .then((entries) => entries.slice(0, limit));
  },

  async clear(workspaceId: string): Promise<void> {
    await db.changeLogs.where('workspaceId').equals(workspaceId).delete();
  },
};
