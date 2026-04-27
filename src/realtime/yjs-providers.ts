import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';
import { useAuthStore, WS_URL } from '@/auth/auth-store';

/**
 * Per-page Yjs context: Y.Doc + IndexedDB persistence (offline cache) +
 * WebsocketProvider for multi-user real-time sync.
 *
 * Authentication: the auth token is appended to the WS URL as `?token=…`
 * and the server verifies it during the WebSocket upgrade. Each page id
 * is the Yjs "room name". The current user's name + color are pushed
 * into awareness so other users can see who is editing.
 *
 * One Y.Doc per page id is cached for the lifetime of the tab so that
 * switching pages and remounting the editor preserves in-memory state
 * and avoids churn on the WebSocket connection.
 */
export interface PageYContext {
  doc: Y.Doc;
  persistence: IndexeddbPersistence;
  provider: WebsocketProvider;
  awareness: Awareness;
  whenSynced: Promise<void>;
}

const cache = new Map<string, PageYContext>();

function applyAwarenessUser(awareness: Awareness): void {
  const user = useAuthStore.getState().user;
  if (!user) return;
  awareness.setLocalStateField('user', {
    id: user.id,
    name: user.username,
    color: user.color,
  });
}

export function getPageYContext(pageId: string): PageYContext {
  const cached = cache.get(pageId);
  if (cached) {
    // The user may have logged in/out since the context was created.
    applyAwarenessUser(cached.awareness);
    return cached;
  }

  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(`alysa-page-${pageId}`, doc);

  const token = useAuthStore.getState().token ?? '';
  const provider = new WebsocketProvider(`${WS_URL}/yjs`, pageId, doc, {
    params: { token },
    connect: true,
  });

  const awareness = provider.awareness;
  applyAwarenessUser(awareness);

  // Keep awareness fresh if the user logs in/out without a reload.
  const unsubscribe = useAuthStore.subscribe((state, prev) => {
    if (state.user !== prev.user) applyAwarenessUser(awareness);
  });
  provider.on('connection-close', () => unsubscribe());

  const whenSynced = persistence.whenSynced.then(() => undefined);

  const ctx: PageYContext = { doc, persistence, provider, awareness, whenSynced };
  cache.set(pageId, ctx);
  return ctx;
}

/**
 * Tear down every per-page Yjs context. Called on logout (and defensively
 * on login) so the next session opens fresh providers with the current
 * auth token instead of reusing connections built from the old token.
 */
export function disposeAllPageDocs(): void {
  for (const ctx of cache.values()) {
    try { ctx.provider.disconnect(); } catch { /* ignore */ }
    try { ctx.provider.destroy(); } catch { /* ignore */ }
    try { ctx.persistence.destroy(); } catch { /* ignore */ }
    try { ctx.doc.destroy(); } catch { /* ignore */ }
  }
  cache.clear();
}
