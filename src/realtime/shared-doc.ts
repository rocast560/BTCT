/**
 * Single shared Yjs document containing all workspace metadata
 * (workspaces, pages, graphs, graph nodes, graph edges, attack chains,
 * change logs, nmap scans, nmap machines).
 *
 * Real-time editing model
 * ───────────────────────
 * This is the source of truth for the entire app state visible in the
 * sidebar AND for every collaboratively-edited text field.
 *
 *   • Sidebar/list metadata (icons, types, parents, timestamps, …) lives
 *     in Y.Map<id, JSON-record> per table. These rows are coarse-grained
 *     last-writer-wins, which is correct for non-textual fields.
 *
 *   • Every collaboratively-edited text field — page title, page slug,
 *     graph node label, graph edge label, nmap hostname, etc. — lives as
 *     a Y.Text inside the `texts` Y.Map keyed `<entity>:<id>:<field>`.
 *     The UI binds inputs to these Y.Texts using diff-based deltas
 *     (insert / delete) so two users can type into the same field at
 *     the same time without losing characters — exactly how Google Docs,
 *     Notion, Linear, etc. handle text. A central observer (see
 *     `mirrorTextsToRecords`) writes the resulting string back into the
 *     JSON record snapshot so read-only consumers (sidebar, tab title,
 *     search) keep working without changes.
 *
 *   • Long-form note bodies (Milkdown markdown) use a *separate* per-page
 *     Y.Doc with the existing collab plugin. See realtime/yjs-providers.ts.
 *
 * Networking:
 *   - WebsocketProvider connects to the Bun collab server, room name
 *     "alysa-shared". Auth token is sent as a query param so the server
 *     can reject unauthenticated clients.
 *   - IndexedDB persistence keeps a local cache so the UI can render
 *     instantly while the WS catches up.
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
  /** Y.Map<key, Y.Text> — collaborative text fields. Key is `<entity>:<id>:<field>`. */
  texts: Y.Map<Y.Text>;
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
  const texts = doc.getMap<Y.Text>('texts');

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

  ctx = { doc, persistence, provider, tables, texts, whenReady };

  // Wire the Y.Text -> JSON snapshot mirror so sidebar/tab labels/search
  // see authoritative text values without each consumer having to know
  // about Y.Text. Done lazily after `ctx` is assigned so the helper can
  // safely call getSharedDoc().
  mirrorTextsToRecords();

  // Once the doc has fully synced (IDB + WS), seed any missing Y.Texts
  // for records that were created before the Y.Text registry existed
  // (or by clients that didn't pre-seed). Without this, those records'
  // text fields silently fall back to last-writer-wins on the JSON map
  // and concurrent edits drop characters.
  void whenReady.then(() => {
    if (!ctx) return;
    seedMissingYTexts(ctx);
  });

  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────
// Y.Text registry
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical key for a collaborative text field. We use a flat
 * namespace (`page:<id>:title`) rather than nested Y.Maps so it's cheap
 * to enumerate and reason about, and so individual Y.Texts can be created
 * lazily without restructuring the parent record.
 */
export function textKey(entity: string, id: string, field: string): string {
  return `${entity}:${id}:${field}`;
}

/**
 * Get-or-create the Y.Text for a given key. If the Y.Text doesn't exist
 * yet, it's seeded with `initial`. The init is wrapped in a transaction
 * and double-checks the map to avoid the common "two clients race to
 * create" footgun (last-writer wins on the map slot, but at least the
 * losing client's reference is then re-read so its observers fire on
 * the surviving Y.Text).
 */
export function getOrInitYText(key: string, initial: string): Y.Text {
  const c = getSharedDoc();
  let t = c.texts.get(key);
  if (t) return t;
  sharedTransact(() => {
    t = c.texts.get(key);
    if (!t) {
      t = new Y.Text();
      if (initial) t.insert(0, initial);
      c.texts.set(key, t);
    }
  });
  // After the transaction, re-fetch — another peer may have set a
  // different Y.Text into the slot.
  return c.texts.get(key) ?? t!;
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

// ─────────────────────────────────────────────────────────────────────────
// Y.Text -> JSON record mirror
// ─────────────────────────────────────────────────────────────────────────

/**
 * Maps "<entity>:<id>:<field>" → which JSON table the snapshot lives in.
 * Add new collaborative text fields here.
 */
const TEXT_FIELD_TO_TABLE: Record<string, TableName> = {
  page: 'pages',
  node: 'graphNodes',
  edge: 'graphEdges',
  workspace: 'workspaces',
  graph: 'graphs',
  nmapScan: 'nmapScans',
  nmapMachine: 'nmapMachines',
  attackChain: 'attackChains',
};

let mirrorBound = false;

/**
 * Watch every Y.Text in the `texts` map (deeply, so we catch insert/delete
 * deltas too) and write the resulting plain string back into the matching
 * JSON record snapshot. This keeps `pages.title`, `graphNodes.label`,
 * `nmapMachines.hostname`, etc. consistent with the authoritative Y.Text
 * for any code that just reads those strings (sidebar tree, tab labels,
 * search index, exports).
 */
function mirrorTextsToRecords() {
  if (mirrorBound) return;
  mirrorBound = true;
  const c = ctx;
  if (!c) return;

  const writeBack = (key: string) => {
    const t = c.texts.get(key);
    if (!t) return;
    const [entity, id, field] = key.split(':');
    if (!entity || !id || !field) return;
    const table = TEXT_FIELD_TO_TABLE[entity];
    if (!table) return;
    const map = c.tables[table];
    const cur = map.get(id) as Record<string, unknown> | undefined;
    if (!cur) return;
    const value = t.toString();
    if (cur[field] === value) return;
    sharedTransact(() => {
      map.set(id, { ...cur, [field]: value, updatedAt: Date.now() });
    });
  };

  // observeDeep fires for any nested Y.Text change (insert/delete) AND
  // for additions/removals of Y.Texts in the parent map.
  c.texts.observeDeep((events) => {
    const touched = new Set<string>();
    for (const ev of events) {
      // For changes inside a Y.Text, ev.target is that Y.Text; its key in
      // the parent map is `ev.path[0]`.
      const path = ev.path;
      if (path.length > 0 && typeof path[0] === 'string') {
        touched.add(path[0]);
      }
      // For top-level adds/removes on the texts map, ev.changes.keys has the keys.
      if ('keys' in ev.changes) {
        for (const k of ev.changes.keys.keys()) touched.add(k);
      }
    }
    for (const key of touched) writeBack(key);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Y.Text migration / pre-seeding
// ─────────────────────────────────────────────────────────────────────────

/**
 * Which JSON fields on each table are collaborative Y.Texts. This drives
 * both create-time pre-seeding (in repos) and the post-sync migration
 * pass below.
 */
const TEXT_FIELDS_BY_ENTITY: Record<string, { table: TableName; fields: string[] }> = {
  page:        { table: 'pages',        fields: ['title', 'slug'] },
  node:        { table: 'graphNodes',   fields: ['label'] },
  edge:        { table: 'graphEdges',   fields: ['label'] },
  workspace:   { table: 'workspaces',   fields: ['name'] },
  graph:       { table: 'graphs',       fields: ['name'] },
  nmapScan:    { table: 'nmapScans',    fields: ['name'] },
  nmapMachine: { table: 'nmapMachines', fields: ['hostname'] },
  attackChain: { table: 'attackChains', fields: ['name'] },
};

/**
 * Walk every record in every table and create a Y.Text for any missing
 * `<entity>:<id>:<field>` slot, seeding it from the JSON snapshot. This
 * runs once per session after the initial sync completes, ensuring that
 * records created in older releases (when Y.Text fields didn't exist
 * yet) get migrated lazily without requiring a server-side rewrite.
 */
function seedMissingYTexts(c: SharedDocContext): void {
  c.doc.transact(() => {
    for (const [entity, info] of Object.entries(TEXT_FIELDS_BY_ENTITY)) {
      const map = c.tables[info.table];
      for (const [id, raw] of map.entries()) {
        if (!raw || typeof raw !== 'object') continue;
        const rec = raw as Record<string, unknown>;
        for (const field of info.fields) {
          const key = textKey(entity, String(id), field);
          if (c.texts.has(key)) continue;
          const val = rec[field];
          const t = new Y.Text();
          if (typeof val === 'string' && val.length > 0) t.insert(0, val);
          c.texts.set(key, t);
        }
      }
    }
  });
}
