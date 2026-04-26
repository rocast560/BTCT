/**
 * Single shared Yjs document containing all workspace metadata
 * (workspaces, pages, graphs, graph nodes, graph edges, attack chains,
 * change logs, nmap scans, nmap machines).
 *
 * This is the source of truth for *the entire app state visible in the
 * sidebar*. Per-page note contents continue to live in their own per-page
 * Y.Doc (see getPageYContext) so they get fine-grained CRDT merges.
 *
 * Networking:
 *   - WebsocketProvider connects to the Bun collab server, room name
 *     "alysa-shared". The auth token is appended as a query param so the
 *     server can reject unauthenticated clients.
 *   - IndexedDB persistence keeps a local cache so the UI can render
 *     instantly while the WS catches up (and so brief disconnects don't
 *     lose work).
 *
 * Concurrency model: each "table" is a Y.Map<id, JSON-record>. Records
 * are stored as plain JSON objects and replaced wholesale on update —
 * this is last-writer-wins per record, which is fine for metadata. Real
 * collaborative editing of long text fields happens in the per-page Y.Doc.
 */
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore, WS_URL } from '@/auth/auth-store';

export const TABLE_NAMES = [
  'workspaces',
  'pages',
  'graphs',
  'graphNodes',
  'graphEdges',
  'attackChains',
  'changeLogs',
  'nmapScans',
  'nmapMachines',
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

const SHARED_ROOM = 'alysa-shared';

export interface SharedDocContext {
  doc: Y.Doc;
  persistence: IndexeddbPersistence;
  provider: WebsocketProvider;
  tables: Record<TableName, Y.Map<unknown>>;
  whenReady: Promise<void>;
}

let ctx: SharedDocContext | null = null;

export function getSharedDoc(): SharedDocContext {
  if (ctx) return ctx;

  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(`alysa-${SHARED_ROOM}`, doc);

  const tables = {} as Record<TableName, Y.Map<unknown>>;
  for (const name of TABLE_NAMES) {
    tables[name] = doc.getMap(name);
  }

  const token = useAuthStore.getState().token ?? '';
  const provider = new WebsocketProvider(`${WS_URL}/yjs`, SHARED_ROOM, doc, {
    params: { token },
    connect: true,
  });

  // "Ready" = local IndexedDB has loaded its cached state into the doc
  // AND the websocket has finished its initial sync with the server (or
  // we've waited a short grace period for the server to respond).
  const whenIdb = persistence.whenSynced.then(() => undefined);
  const whenWs = new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    provider.on('sync', (synced: boolean) => { if (synced) finish(); });
    provider.on('status', (e: { status: string }) => {
      // If we connect but never receive a sync event (e.g. server has no
      // state for this room), treat "connected" as ready after a moment.
      if (e.status === 'connected') setTimeout(finish, 250);
    });
    // Hard cap so a broken/missing server doesn't block the UI forever.
    setTimeout(finish, 4000);
  });

  const whenReady = Promise.all([whenIdb, whenWs]).then(() => undefined);

  ctx = { doc, persistence, provider, tables, whenReady };
  return ctx;
}

/**
 * Subscribe to remote changes on a specific table. The callback fires
 * whenever the Y.Map changes (local or remote). Returns an unsubscribe
 * function.
 */
export function subscribeTable(name: TableName, fn: () => void): () => void {
  const c = getSharedDoc();
  const map = c.tables[name];
  const handler = () => fn();
  map.observe(handler);
  return () => map.unobserve(handler);
}

/**
 * Wrap a series of writes in a Yjs transaction so observers fire once.
 */
export function sharedTransact<T>(fn: () => T): T {
  const c = getSharedDoc();
  let result: T;
  c.doc.transact(() => { result = fn(); });
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return result!;
}
