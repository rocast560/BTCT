import { v4 as uuidv4 } from 'uuid';
import { db } from './database';
import type { PageSnapshot } from '@/types';
import type { LogAuthor } from './changelog-repo';

/**
 * Persisted point-in-time captures of a page's body Y.Doc. The bytes are
 * the output of `Y.encodeStateAsUpdate(pageDoc)` (the full doc state, not
 * a state vector), base64-encoded so it round-trips cleanly through the
 * shared Yjs JSON map. Restore = apply those bytes back to the live doc.
 */
export const pageSnapshotRepo = {
  async add(
    workspaceId: string,
    pageId: string,
    updateBytes: Uint8Array,
    author: LogAuthor = { userId: null, userName: null, userColor: null },
    label: string | null = null,
  ): Promise<PageSnapshot> {
    const snap: PageSnapshot = {
      id: uuidv4(),
      pageId,
      workspaceId,
      timestamp: Date.now(),
      userId: author.userId,
      userName: author.userName,
      userColor: author.userColor,
      label: label ?? null,
      updateBase64: bytesToBase64(updateBytes),
      byteLength: updateBytes.byteLength,
    };
    await db.pageSnapshots.add(snap);
    return snap;
  },

  async getByPage(pageId: string): Promise<PageSnapshot[]> {
    const all = await db.pageSnapshots.where('pageId').equals(pageId).toArray();
    all.sort((a, b) => b.timestamp - a.timestamp);
    return all;
  },

  async remove(id: string): Promise<void> {
    await db.pageSnapshots.delete(id);
  },

  /**
   * Drop automatic (un-labelled) snapshots older than maxAutoCount per page,
   * keeping the most recent. Named (labelled) snapshots are never pruned.
   */
  async pruneAuto(pageId: string, maxAutoCount: number): Promise<number> {
    const snaps = await this.getByPage(pageId);
    const autos = snaps.filter((s) => !s.label);
    if (autos.length <= maxAutoCount) return 0;
    const toDelete = autos.slice(maxAutoCount);
    for (const s of toDelete) await db.pageSnapshots.delete(s.id);
    return toDelete.length;
  },
};

function bytesToBase64(bytes: Uint8Array): string {
  // chunk to stay under the spread-arg argument limit on large updates
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
