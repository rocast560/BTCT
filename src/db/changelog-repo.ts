import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import type { ChangeAction, ChangeTarget, ChangeLogEntry } from '@/types';

export interface LogAuthor {
  userId: number | null;
  userName: string | null;
  userColor: string | null;
}

export interface LogDelta {
  field?: string | null;
  prevValue?: string | null;
  newValue?: string | null;
  reversible?: boolean;
}

export const changeLogRepo = {
  /**
   * Record a single entry. Author is captured at write time so older logs
   * survive a user being renamed or deleted. `delta` carries the field-level
   * old/new values that make an entry reversible.
   */
  async add(
    workspaceId: string,
    action: ChangeAction,
    target: ChangeTarget,
    targetId: string,
    summary: string,
    author: LogAuthor = { userId: null, userName: null, userColor: null },
    delta: LogDelta = {},
  ): Promise<ChangeLogEntry> {
    const entry: ChangeLogEntry = {
      id: uuidv4(),
      workspaceId,
      action,
      target,
      targetId,
      summary,
      timestamp: Date.now(),
      userId: author.userId,
      userName: author.userName,
      userColor: author.userColor,
      field: delta.field ?? null,
      prevValue: delta.prevValue ?? null,
      newValue: delta.newValue ?? null,
      reversible: delta.reversible ?? false,
    };
    await db.changeLogs.add(entry);
    return entry;
  },

  async getByWorkspace(workspaceId: string, limit = 200): Promise<ChangeLogEntry[]> {
    return db.changeLogs
      .where('workspaceId')
      .equals(workspaceId)
      .reverse()
      .sortBy('timestamp')
      .then((entries) => entries.slice(0, limit));
  },

  /** Latest entry that touched a specific entity (any field). */
  async latestForTarget(workspaceId: string, target: ChangeTarget, targetId: string): Promise<ChangeLogEntry | null> {
    const all = await db.changeLogs
      .where('workspaceId').equals(workspaceId)
      .toArray();
    const matches = all.filter((e) => e.target === target && e.targetId === targetId);
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.timestamp - a.timestamp);
    return matches[0] ?? null;
  },

  async clear(workspaceId: string): Promise<void> {
    await db.changeLogs.where('workspaceId').equals(workspaceId).delete();
  },
};
