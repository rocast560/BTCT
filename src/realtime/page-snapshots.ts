/**
 * Page-body snapshots. The live body of each page lives in its own Y.Doc
 * (see `yjs-providers.ts`), so we can't roll back a page from the regular
 * `changeLogs` table — which only sees high-level metadata events.
 *
 * Instead we periodically encode the entire page Y.Doc as an update blob
 * via `Y.encodeStateAsUpdate(doc)` and store the bytes (base64) in the
 * shared `pageSnapshots` table. Restoring = decode → temp Y.Doc → clone
 * the snapshot's `prosemirror` XmlFragment children back into the live
 * doc, replacing current body content. Because the replacement runs
 * inside a single Y transaction it merges deterministically across all
 * connected clients (every collaborator sees the rollback the same way).
 *
 * Cadence: auto-snapshot 2 minutes after the last keystroke on a page,
 * with a per-page cap so the log doesn't grow forever. Named snapshots
 * (passed `label`) are never pruned.
 */
import * as Y from 'yjs';
import { pageSnapshotRepo, base64ToBytes } from '@/db';
import { useAuthStore } from '@/auth/auth-store';
import { getPageYContext } from './yjs-providers';
import type { PageSnapshot } from '@/types';

const AUTO_IDLE_MS = 2 * 60 * 1000;        // 2 minutes since last edit
const AUTO_RETAIN_PER_PAGE = 20;           // keep the 20 newest auto snapshots
const debounceTimers = new Map<string, number>();

function currentAuthor() {
  const u = useAuthStore.getState().user;
  if (!u) return { userId: null, userName: null, userColor: null };
  return { userId: u.id, userName: u.username, userColor: u.color };
}

/** Capture immediately and persist. Used by the explicit "Save version" UI. */
export async function captureSnapshotNow(
  pageId: string,
  workspaceId: string,
  label: string | null = null,
): Promise<PageSnapshot> {
  const ctx = getPageYContext(pageId);
  const bytes = Y.encodeStateAsUpdate(ctx.doc);
  return pageSnapshotRepo.add(workspaceId, pageId, bytes, currentAuthor(), label);
}

/**
 * Debounced auto-snapshot. Reset the timer on each call; when it fires
 * (after AUTO_IDLE_MS of inactivity) capture and prune old autos.
 */
export function scheduleAutoSnapshot(pageId: string, workspaceId: string): void {
  const existing = debounceTimers.get(pageId);
  if (existing) window.clearTimeout(existing);
  const tid = window.setTimeout(() => {
    debounceTimers.delete(pageId);
    void captureSnapshotNow(pageId, workspaceId).then(
      () => pageSnapshotRepo.pruneAuto(pageId, AUTO_RETAIN_PER_PAGE),
    );
  }, AUTO_IDLE_MS);
  debounceTimers.set(pageId, tid);
}

/**
 * Replace the live page body with the contents of a snapshot. Implemented
 * by decoding the snapshot into a throwaway Y.Doc, deep-cloning the
 * `prosemirror` XmlFragment children, and swapping them into the live
 * fragment within one Y transaction. Y.XmlElement / Y.XmlText.clone()
 * returns detached copies safe to insert into a different parent doc.
 */
export function restoreSnapshot(pageId: string, updateBase64: string): void {
  const ctx = getPageYContext(pageId);
  const liveDoc = ctx.doc;
  const liveFragment = liveDoc.getXmlFragment('prosemirror');

  const tmpDoc = new Y.Doc();
  Y.applyUpdate(tmpDoc, base64ToBytes(updateBase64));
  const snapFragment = tmpDoc.getXmlFragment('prosemirror');

  // Snapshot the children first; we'll iterate after deleting the live
  // ones (deleting first would invalidate the array if we reused refs
  // across docs, but in practice these are separate docs — safe either
  // way; collecting up-front is clearer).
  const replacementChildren = snapFragment.toArray().map((child) => {
    // Both Y.XmlElement and Y.XmlText expose .clone(); we can't share
    // the same type ref across docs, so clone unconditionally.
    return (child as Y.XmlElement | Y.XmlText).clone();
  });

  liveDoc.transact(() => {
    if (liveFragment.length > 0) {
      liveFragment.delete(0, liveFragment.length);
    }
    if (replacementChildren.length > 0) {
      liveFragment.insert(0, replacementChildren);
    }
  });

  tmpDoc.destroy();
}
