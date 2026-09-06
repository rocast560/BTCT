import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';
import { useAuthStore, WS_URL } from '@/auth/auth-store';
import { attachUserMapping } from './page-history-api';

export interface PageYContext {
  doc: Y.Doc;
  persistence: IndexeddbPersistence;
  provider: WebsocketProvider;
  awareness: Awareness;
  unsubscribeAuth: () => void;
  /** IndexedDB has loaded. */
  whenSynced: Promise<void>;
  /** IndexedDB and initial server sync, with a 3s offline fallback. */
  whenFullySynced: Promise<void>;
}
interface Entry {
  ctx: PageYContext;
  leases: number;
  closing: boolean;
  destroyed: boolean;
  cancelSync: () => void;
}
const cache = new Map<string, Entry>();
let openPages = new Set<string>();

function applyAwarenessUser(awareness: Awareness): void {
  const user = useAuthStore.getState().user;
  awareness.setLocalStateField('user', user ? { id: user.id, name: user.username, color: user.color } : null);
}

/** Keep open page/history tabs, including those behind the selected tab. */
export function syncOpenPageDocs(pageIds: Iterable<string>): void {
  openPages = new Set(pageIds);
  for (const [id, entry] of cache) scheduleRelease(id, entry);
}
function unused(id: string, entry: Entry): boolean {
  return !openPages.has(id) && entry.leases === 0 && !entry.destroyed && cache.get(id) === entry;
}

/** The transaction must commit before closing; no persistent cache is deleted. */
function persistBeforeClose(ctx: PageYContext): Promise<void> {
  const db = ctx.persistence.db;
  if (!db) return Promise.reject(new Error('Page offline cache is unavailable'));
  return new Promise((resolve, reject) => {
    const tx = db.transaction('updates', 'readwrite');
    tx.objectStore('updates').add(Y.encodeStateAsUpdate(ctx.doc));
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Could not save page offline'));
  });
}
function destroy(entry: Entry): void {
  entry.destroyed = true;
  entry.cancelSync();
  entry.ctx.unsubscribeAuth();
  entry.ctx.provider.destroy();
  void entry.ctx.persistence.destroy().catch(() => undefined);
  entry.ctx.doc.destroy();
}
function scheduleRelease(id: string, entry: Entry): void {
  if (!unused(id, entry) || entry.closing) return;
  entry.closing = true;
  // Let React detach the editor. Also absorb StrictMode and split-pane moves.
  setTimeout(() => {
    void (async () => {
      try {
        await entry.ctx.whenFullySynced;
        if (!unused(id, entry)) return;
        await persistBeforeClose(entry.ctx);
        if (!unused(id, entry)) return;
        cache.delete(id);
        destroy(entry);
      } catch (error) {
        // Preserve unsaved work if IndexedDB is full/blocked. Later tab changes retry.
        console.warn('[page-cache] Could not release a page safely:', error);
      } finally {
        entry.closing = false;
      }
    })();
  }, 0);
}

/** Temporary callers use withPageYContext to hold the document through their work. */
export function getPageYContext(pageId: string): PageYContext {
  const cached = cache.get(pageId);
  if (cached) return cached.ctx;
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(`btct-page-${pageId}`, doc);
  const provider = new WebsocketProvider(`${WS_URL}/yjs`, pageId, doc, {
    params: { token: useAuthStore.getState().token ?? '' }, connect: true,
  });
  const awareness = provider.awareness;
  applyAwarenessUser(awareness);
  const unsubscribeAuth = useAuthStore.subscribe((state, prev) => {
    if (state.user !== prev.user) {
      applyAwarenessUser(awareness);
      if (state.user && !doc.isDestroyed) attachUserMapping(doc);
    }
  });
  let cancelSync = () => {};
  const whenWsSynced = new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); provider.off('sync', onSync); resolve(); };
    const onSync = (synced: boolean) => { if (synced) finish(); };
    const timer = setTimeout(finish, 3000);
    cancelSync = finish;
    if (provider.synced) finish();
    else provider.on('sync', onSync);
  });
  const whenSynced = persistence.whenSynced.then(() => undefined);
  const whenFullySynced = Promise.all([whenSynced, whenWsSynced]).then(() => undefined);
  const ctx: PageYContext = { doc, persistence, provider, awareness, unsubscribeAuth, whenSynced, whenFullySynced };
  const entry: Entry = { ctx, leases: 0, closing: false, destroyed: false, cancelSync };
  cache.set(pageId, entry);
  void whenFullySynced.then(() => { if (!entry.destroyed) attachUserMapping(doc); });
  scheduleRelease(pageId, entry);
  return ctx;
}
/** Hold a document until an editor has detached or a temporary operation finishes. */
export function retainPageYContext(pageId: string): () => void {
  getPageYContext(pageId);
  const entry = cache.get(pageId)!;
  entry.leases++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.leases--;
    scheduleRelease(pageId, entry);
  };
}
export async function withPageYContext<T>(pageId: string, work: (ctx: PageYContext) => T | Promise<T>): Promise<T> {
  const release = retainPageYContext(pageId);
  try { return await work(getPageYContext(pageId)); }
  finally { release(); }
}

/** Detach network access immediately at logout; save before freeing the old doc. */
export function disposeAllPageDocs(): void {
  const entries = [...cache.values()];
  cache.clear();
  openPages.clear();
  for (const entry of entries) {
    entry.ctx.unsubscribeAuth();
    entry.ctx.provider.disconnect();
    entry.cancelSync();
    void entry.ctx.whenSynced.then(() => persistBeforeClose(entry.ctx))
      .catch((error) => console.warn('[page-cache] Offline save failed during logout:', error))
      .finally(() => destroy(entry));
  }
}
