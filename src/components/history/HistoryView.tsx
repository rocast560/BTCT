import { pollWhileVisible } from '@/lib/visible-poll';
// ─────────────────────────────────────────────────────────────────────────
// Version history tab (kind: 'history', entityId: pageId).
//
// Google Docs layout: the rendered version on the left, a day-grouped
// timeline on the right. "Show changes" colours every insertion and
// deletion between the selected version and the one before it per user,
// using y-prosemirror's snapshot renderer over the page's GC-off history
// twin (downloaded once). Restore rewrites the live page as a forward edit
// and records a `restore` version, so nothing is ever lost.
//
// The viewer is its own read-only ProseMirror instance with the editor's
// schema plus `ychange` attributes (lib/history-schema.ts); it never touches
// a live editor (invariant #3).
// ─────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { EditorState } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';
import type { Schema, Node as PmNode } from '@milkdown/prose/model';
import { ySyncPlugin, ySyncPluginKey, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { Crepe } from '@milkdown/crepe';
import { schemaCtx } from '@milkdown/core';
import { History, RotateCcw, Tag, Trash2, Check, X, Eye, EyeOff, Save } from 'lucide-react';
import { useAppStore } from '@/stores';
import { useAuthStore } from '@/auth/auth-store';
import { highlightPlugin } from '@/lib/highlight-plugin';
import { withYChange, ychangeDomAttrs } from '@/lib/history-schema';
import { assetImageSchema } from '@/lib/asset-image';
import { resolveAssetBytes, fetchAssetBytes } from '@/lib/assets';
import { cn } from '@/lib/utils';
import {
  filterVersions,
  formatVersionTime,
  groupVersionsByDay,
  previousDiffable,
  versionLabel,
} from '@/lib/page-history';
import {
  createVersion,
  deleteVersion,
  fetchTwin,
  getVersion,
  listVersions,
  renameVersion,
  type VersionBytes,
  type VersionListResponse,
} from '@/realtime/page-history-api';
import { restoreFromState } from '@/realtime/page-snapshots';
import { getPageYContext } from '@/realtime/yjs-providers';
import type { PageVersion, PageVersionUser } from '@/types';

const FRAGMENT = 'prosemirror';
const FALLBACK_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#ec4899', '#8b5cf6', '#14b8a6'].map((c) => ({ light: c, dark: c }));

// ── Viewer schema: the editor's, built once headlessly, plus ychange ─────
// The headless Crepe stays alive for the session: Milkdown node specs read
// their attribute contexts (paragraphAttr and friends) from the owning
// editor's ctx inside toDOM, so destroying it would break every render.
let headless: Crepe | null = null;
let schemaPromise: Promise<Schema> | null = null;
function viewerSchema(): Promise<Schema> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const root = document.createElement('div');
      const crepe = new Crepe({ root, defaultValue: '' });
      crepe.editor.use(highlightPlugin);
      // Include the note-image node so a version that has images can be built
      // and rendered (a nodeView below resolves the actual picture).
      crepe.editor.use(assetImageSchema);
      await crepe.create();
      headless = crepe;
      return withYChange(crepe.editor.ctx.get(schemaCtx));
    })().catch((err) => {
      schemaPromise = null;
      headless = null;
      throw err;
    });
  }
  return schemaPromise;
}
void headless;

type ViewerSelection =
  | { kind: 'live' }
  | { kind: 'state'; state: Uint8Array }
  | { kind: 'diff'; snapshot: Uint8Array | null; prevSnapshot: Uint8Array | null; showChanges: boolean };

function sameSelection(a: ViewerSelection | null, b: ViewerSelection): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'live' || b.kind === 'live') return true;
  if (a.kind === 'state' && b.kind === 'state') return a.state === b.state;
  if (a.kind === 'diff' && b.kind === 'diff') {
    return a.snapshot === b.snapshot && a.prevSnapshot === b.prevSnapshot && a.showChanges === b.showChanges;
  }
  return false;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameList(a: VersionListResponse, b: VersionListResponse): boolean {
  return a.dirty === b.dirty && a.tracked === b.tracked && a.twinExists === b.twinExists
    && JSON.stringify(a.versions) === JSON.stringify(b.versions)
    && JSON.stringify(a.users) === JSON.stringify(b.users);
}

// Node views for the read-only version viewer: render `asset_image` nodes as
// the actual (cropped/blurred) picture so a version you're about to restore
// shows what it was. Retired assets still resolve while their bytes survive
// the retention window; once pruned, a placeholder is shown.
const historyNodeViews = {
  asset_image: (node: PmNode) => {
    const dom = document.createElement('div');
    dom.className = 'pm-image asset-image asset-image-history';
    const ych = ychangeDomAttrs((node.attrs as { ychange?: Parameters<typeof ychangeDomAttrs>[0] }).ychange ?? null);
    for (const [k, v] of Object.entries(ych)) dom.setAttribute(k, v);
    const img = document.createElement('img');
    img.alt = (node.attrs.alt as string) || '';
    dom.appendChild(img);

    let objUrl: string | null = null;
    const assetId = node.attrs.assetId as string;
    const asset = useAppStore.getState().typstAssets.find((a) => a.id === assetId);
    const bytes = asset ? resolveAssetBytes(asset) : fetchAssetBytes(assetId);
    void bytes
      .then((b) => {
        objUrl = URL.createObjectURL(new Blob([b.slice().buffer as ArrayBuffer], { type: 'image/png' }));
        img.src = objUrl;
      })
      .catch(() => { img.alt = 'image no longer available'; dom.classList.add('asset-image-missing'); });

    return {
      dom,
      ignoreMutation: () => true,
      destroy: () => { if (objUrl) URL.revokeObjectURL(objUrl); },
    };
  },
};

// ── The read-only rendering surface ──────────────────────────────────────
function VersionViewer({
  schema,
  twin,
  users,
  selection,
}: {
  schema: Schema;
  twin: Uint8Array | null;
  users: Record<string, PageVersionUser>;
  selection: ViewerSelection | null;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || !selection) return;
    el.innerHTML = '';
    let view: EditorView | null = null;
    let doc: Y.Doc | null = null;
    try {
      if (selection.kind === 'diff' && twin) {
        doc = new Y.Doc({ gc: false });
        Y.applyUpdate(doc, twin);
        const pud = new Y.PermanentUserData(doc);
        const colorMapping = new Map<string, { light: string; dark: string }>();
        for (const [id, u] of Object.entries(users)) colorMapping.set(id, { light: u.color, dark: u.color });
        colorMapping.set('unknown', { light: '#9ca3af', dark: '#9ca3af' });
        const plugin = ySyncPlugin(doc.getXmlFragment(FRAGMENT), {
          permanentUserData: pud,
          colorMapping,
          colors: FALLBACK_COLORS,
        });
        view = new EditorView(el, {
          state: EditorState.create({ schema, plugins: [plugin] }),
          editable: () => false,
          nodeViews: historyNodeViews,
        });
        const snapshot = selection.snapshot ? Y.decodeSnapshot(selection.snapshot) : Y.snapshot(doc);
        const prevSnapshot = selection.showChanges
          ? selection.prevSnapshot
            ? Y.decodeSnapshot(selection.prevSnapshot)
            : Y.emptySnapshot
          : snapshot;
        view.dispatch(view.state.tr.setMeta(ySyncPluginKey, { snapshot, prevSnapshot }));
      } else {
        const bytes = selection.kind === 'state' ? selection.state : twin;
        doc = new Y.Doc({ gc: false });
        if (bytes) Y.applyUpdate(doc, bytes);
        const node = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(FRAGMENT), schema);
        view = new EditorView(el, {
          state: EditorState.create({ schema, doc: node }),
          editable: () => false,
          nodeViews: historyNodeViews,
        });
      }
    } catch (err) {
      el.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'text-xs text-[hsl(var(--destructive))]';
      p.textContent = `Could not render this version: ${err instanceof Error ? err.message : String(err)}`;
      el.appendChild(p);
    }
    return () => {
      view?.destroy();
      doc?.destroy();
    };
  }, [schema, twin, users, selection]);

  return (
    <div
      className="history-viewer milkdown-host"
      data-kind={selection?.kind ?? 'none'}
      data-twin={twin ? twin.byteLength : 0}
      data-changes={selection?.kind === 'diff' && selection.showChanges ? 'on' : 'off'}
    >
      <div className="milkdown" ref={host} />
    </div>
  );
}

// ── The tab ──────────────────────────────────────────────────────────────
export function HistoryView({ pageId }: { pageId: string }) {
  const page = useAppStore((s) => s.pages.find((p) => p.id === pageId));
  const closeTab = useAppStore((s) => s.closeTab);
  const ownTab = useAppStore((s) => s.tabs.find((t) => t.kind === 'history' && t.entityId === pageId));
  const authUser = useAuthStore((s) => s.user);

  const [data, setData] = useState<VersionListResponse | null>(null);
  const [twin, setTwin] = useState<Uint8Array | null>(null);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  const [namedOnly, setNamedOnly] = useState(false);
  const [userFilter, setUserFilter] = useState<number | null>(null);
  const [selection, setSelection] = useState<ViewerSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bytesCache = useRef(new Map<string, VersionBytes>());

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 4000);
  }, []);

  // The twin is only re-downloaded when the version list actually moved
  // (a new version, or unsaved edits appeared); the 30 s poll otherwise costs
  // one small JSON request, and identical bytes never rebuild the viewer.
  const latestRef = useRef<{ id: string | null; dirty: boolean } | null>(null);
  const refresh = useCallback(async (opts: { twin?: boolean } = {}) => {
    const list = await listVersions(pageId);
    const latest = list.versions[0]?.id ?? null;
    const moved = !latestRef.current || latestRef.current.id !== latest || latestRef.current.dirty !== list.dirty;
    latestRef.current = { id: latest, dirty: list.dirty };
    setData((prev) => (prev && sameList(prev, list) ? prev : list));
    if (opts.twin || moved) {
      const bytes = await fetchTwin(pageId).catch(() => null);
      setTwin((prev) => (prev && bytes && sameBytes(prev, bytes) ? prev : bytes));
    }
  }, [pageId]);

  useEffect(() => {
    // Keep the page room open so the server twin follows live edits.
    getPageYContext(pageId);
    let cancelled = false;
    viewerSchema()
      .then((s) => { if (!cancelled) setSchema(s); })
      .catch((err) => setError(`Viewer failed to start: ${err instanceof Error ? err.message : String(err)}`));
    let firstRefresh = true;
    const stopPolling = pollWhileVisible(async () => {
      const initial = firstRefresh;
      firstRefresh = false;
      try { await refresh({ twin: initial }); }
      catch (err) { if (initial && !cancelled) setError(err instanceof Error ? err.message : String(err)); }
    }, 60_000);
    return () => { cancelled = true; stopPolling(); };
  }, [pageId, refresh]);

  const loadBytes = useCallback(async (versionId: string): Promise<VersionBytes> => {
    const hit = bytesCache.current.get(versionId);
    if (hit) return hit;
    const b = await getVersion(pageId, versionId);
    bytesCache.current.set(versionId, b);
    return b;
  }, [pageId]);

  // Resolve what the viewer should show for the current selection. Only a
  // real change reaches state: the viewer rebuilds on every new selection
  // object, and the poll would otherwise rebuild it twice a minute.
  const select = useCallback((next: ViewerSelection) => {
    setSelection((prev) => (sameSelection(prev, next) ? prev : next));
  }, []);
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    (async () => {
      const latestDiffable = data.versions.find((v) => v.diffable) ?? null;
      if (!selectedId) {
        if (showChanges && latestDiffable && twin) {
          const prev = await loadBytes(latestDiffable.id);
          if (!cancelled) select({ kind: 'diff', snapshot: null, prevSnapshot: prev.snapshot, showChanges: true });
        } else if (!cancelled) {
          select({ kind: 'live' });
        }
        return;
      }
      const v = data.versions.find((x) => x.id === selectedId);
      if (!v) { if (!cancelled) select({ kind: 'live' }); return; }
      const bytes = await loadBytes(v.id);
      if (cancelled) return;
      if (v.diffable && bytes.snapshot && twin) {
        const prev = previousDiffable(data.versions, v);
        const prevBytes = prev ? (await loadBytes(prev.id)).snapshot : null;
        if (!cancelled) select({ kind: 'diff', snapshot: bytes.snapshot, prevSnapshot: prevBytes, showChanges });
      } else if (bytes.state) {
        select({ kind: 'state', state: bytes.state });
      }
    })().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => { cancelled = true; };
  }, [data, twin, selectedId, showChanges, loadBytes, select]);

  const versions = data?.versions ?? [];
  const usersKey = JSON.stringify(data?.users ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const users = useMemo(() => data?.users ?? {}, [usersKey]);
  const visible = useMemo(() => filterVersions(versions, { namedOnly, userId: userFilter }), [versions, namedOnly, userFilter]);
  const groups = useMemo(() => groupVersionsByDay(visible), [visible]);
  const selected = selectedId ? versions.find((v) => v.id === selectedId) ?? null : null;
  const userList = useMemo(() => Object.values(users).filter((u) => u.id !== 0), [users]);

  const canDelete = (v: PageVersion) => !!authUser && (authUser.isAdmin || (!!v.name && v.createdBy === authUser.id));

  const saveNamed = async () => {
    setBusy(true);
    try {
      await createVersion(pageId, { name: naming?.trim() || null, trigger: 'named' });
      setNaming(null);
      flash('Version saved.');
      await refresh();
    } catch (err) {
      flash(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    setBusy(true);
    try {
      await renameVersion(pageId, renaming.id, renaming.value.trim());
      setRenaming(null);
      await refresh();
    } catch (err) {
      flash(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (id: string) => {
    setBusy(true);
    try {
      await deleteVersion(pageId, id);
      bytesCache.current.delete(id);
      if (selectedId === id) setSelectedId(null);
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      flash(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const bytes = await loadBytes(selected.id);
      if (!bytes.state) throw new Error('this version has no content to restore');
      // Never rewrite a page doc that has not synced yet: the restore would
      // merge with the remote state that arrives a moment later.
      await getPageYContext(pageId).whenFullySynced;
      const how = restoreFromState(pageId, bytes.state);
      // PermanentUserData records the delete set of a local transaction on a
      // timer; give it (and the relay) a moment so the restore version
      // credits the deletions to this account instead of "unknown".
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      await createVersion(pageId, {
        trigger: 'restore',
        name: `Restored ${versionLabel(selected)} (${formatVersionTime(selected.createdAt)})`,
      }).catch(() => { /* the page may not be tracked yet; the rollback itself already happened */ });
      setConfirmRestore(false);
      setSelectedId(null);
      flash(how === 'editor' ? 'Restored. Everyone sees the change; later versions are kept.' : 'Restored.');
      await refresh();
    } catch (err) {
      flash(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const userChip = (id: number) => {
    const u = users[String(id)];
    return (
      <span key={id} className="inline-flex items-center gap-1">
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: u?.color ?? '#9ca3af' }} aria-hidden />
        {u?.username ?? (id === 0 ? 'unknown' : `user ${id}`)}
      </span>
    );
  };

  return (
    <div className="flex h-full flex-col bg-[hsl(var(--background))]">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[hsl(var(--border))] px-4">
        <History size={14} className="shrink-0 text-[hsl(var(--primary))]" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">
          Version history
          <span className="font-normal text-[hsl(var(--muted-foreground))]"> · {page?.title ?? 'Page'}</span>
        </div>
        <button
          type="button"
          onClick={() => setShowChanges((v) => !v)}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs',
            showChanges
              ? 'border-[hsl(var(--primary))]/50 bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]'
              : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]',
          )}
          title="Colour insertions and deletions per user"
        >
          {showChanges ? <Eye size={12} /> : <EyeOff size={12} />} Show changes
        </button>
        {naming === null ? (
          <button
            type="button"
            onClick={() => setNaming('')}
            className="flex items-center gap-1.5 rounded-md border border-[hsl(var(--border))] px-2.5 py-1 text-xs hover:bg-[hsl(var(--accent))]"
            title="Save the current page as a named version"
          >
            <Save size={12} /> Save version
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveNamed(); if (e.key === 'Escape') setNaming(null); }}
              placeholder="Version name"
              className="w-44 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2.5 py-1 text-xs outline-none focus:border-[hsl(var(--primary))]"
            />
            <button type="button" onClick={() => void saveNamed()} disabled={busy} className="rounded-md bg-[hsl(var(--primary))] px-2.5 py-1 text-xs font-medium text-[hsl(var(--primary-foreground))] disabled:opacity-50">
              Save
            </button>
            <button type="button" onClick={() => setNaming(null)} className="rounded-md p-1 hover:bg-[hsl(var(--accent))]" title="Cancel">
              <X size={12} />
            </button>
          </div>
        )}
        {selected && (
          <button
            type="button"
            onClick={() => setConfirmRestore(true)}
            disabled={busy || confirmRestore}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-[hsl(var(--primary))] px-3 py-1 text-xs font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
          >
            <RotateCcw size={12} /> Restore this version
          </button>
        )}
        <button
          type="button"
          onClick={() => { if (ownTab) closeTab(ownTab.id); }}
          className="shrink-0 rounded-md p-1 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
          title="Close version history"
        >
          <X size={14} />
        </button>
      </div>

      {selected && confirmRestore && (
        <div className="flex shrink-0 items-center gap-3 border-b border-[hsl(var(--primary))]/40 bg-[hsl(var(--primary))]/10 px-4 py-2 text-xs">
          <span className="min-w-0 flex-1">
            Replace the current page with <strong>{versionLabel(selected)}</strong> ({formatVersionTime(selected.createdAt)})? Everyone sees the change; later versions are kept.
          </span>
          <button type="button" onClick={() => void doRestore()} disabled={busy} className="flex shrink-0 items-center gap-1 rounded-md bg-[hsl(var(--primary))] px-2.5 py-1 font-medium text-[hsl(var(--primary-foreground))] disabled:opacity-50">
            <Check size={11} /> Restore
          </button>
          <button type="button" onClick={() => setConfirmRestore(false)} className="shrink-0 rounded-md border border-[hsl(var(--border))] px-2.5 py-1 hover:bg-[hsl(var(--accent))]">
            Cancel
          </button>
        </div>
      )}

      {notice && (
        <div className="shrink-0 border-b border-[hsl(var(--border))] bg-[hsl(var(--accent))] px-4 py-1.5 text-xs">{notice}</div>
      )}
      {error && (
        <div className="shrink-0 border-b border-[hsl(var(--border))] bg-[hsl(var(--destructive))]/10 px-4 py-1.5 text-xs text-[hsl(var(--destructive))]">{error}</div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Rendered version */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[800px] px-10 py-8">
            {schema && selection ? (
              <VersionViewer schema={schema} twin={twin} users={users} selection={selection} />
            ) : (
              <div className="text-sm text-[hsl(var(--muted-foreground))]">
                {!twin && data && versions.length === 0
                  ? 'No history yet. A version is recorded about two minutes after editing stops, or when you save one.'
                  : 'Loading…'}
              </div>
            )}
          </div>
        </div>

        {/* Timeline */}
        <aside className="flex w-80 shrink-0 flex-col border-l border-[hsl(var(--border))]">
          <div className="flex flex-col gap-2 border-b border-[hsl(var(--border))] px-4 py-3">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={namedOnly} onChange={(e) => setNamedOnly(e.target.checked)} />
              Only show named versions
            </label>
            {userList.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setUserFilter(null)}
                  className={cn('rounded-full border px-2 py-0.5 text-[11px]', userFilter === null ? 'border-[hsl(var(--primary))]/60 bg-[hsl(var(--primary))]/10' : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]')}
                >
                  Everyone
                </button>
                {userList.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setUserFilter(userFilter === u.id ? null : u.id)}
                    className={cn('flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]', userFilter === u.id ? 'border-[hsl(var(--primary))]/60 bg-[hsl(var(--primary))]/10' : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]')}
                  >
                    <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: u.color }} aria-hidden />
                    {u.username}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3">
            <button
              type="button"
              onClick={() => { setSelectedId(null); setConfirmRestore(false); }}
              className={cn('mb-3 w-full rounded-lg px-3 py-2 text-left', selectedId === null ? 'bg-[hsl(var(--accent))]' : 'hover:bg-[hsl(var(--accent))]/60')}
            >
              <div className="text-xs font-medium">Current version</div>
              <div className="mt-0.5 text-[11px] text-[hsl(var(--muted-foreground))]">
                {data?.dirty ? 'Unsaved edits since the last version' : 'Live page'}
                {showChanges && versions.some((v) => v.diffable) ? ' · showing changes since the last version' : ''}
              </div>
            </button>

            {groups.length === 0 && (
              <div className="px-3 text-xs text-[hsl(var(--muted-foreground))]">
                {versions.length === 0 ? 'No versions yet.' : 'Nothing matches the current filter.'}
              </div>
            )}

            {groups.map((g) => (
              <div key={g.dayKey} className="mb-4">
                <div className="mb-1.5 px-3 text-[11px] font-semibold text-[hsl(var(--muted-foreground))]">{g.label}</div>
                <ul className="space-y-0.5">
                  {g.versions.map((v) => {
                    const isSel = v.id === selectedId;
                    const authors = v.changedBy.length ? v.changedBy : v.createdBy != null ? [v.createdBy] : [];
                    return (
                      <li key={v.id}>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => { setSelectedId(v.id); setConfirmRestore(false); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { setSelectedId(v.id); setConfirmRestore(false); } }}
                          className={cn('w-full cursor-pointer rounded-lg px-3 py-2 text-left', isSel ? 'bg-[hsl(var(--accent))]' : 'hover:bg-[hsl(var(--accent))]/60')}
                        >
                          <div className="flex items-center justify-between gap-2">
                            {renaming?.id === v.id ? (
                              <input
                                autoFocus
                                value={renaming.value}
                                onChange={(e) => setRenaming({ id: v.id, value: e.target.value })}
                                onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); if (e.key === 'Escape') setRenaming(null); }}
                                onBlur={() => void commitRename()}
                                onClick={(e) => e.stopPropagation()}
                                className="min-w-0 flex-1 rounded border border-[hsl(var(--primary))] bg-transparent px-1.5 py-0.5 text-xs outline-none"
                              />
                            ) : (
                              <span className={cn('truncate text-xs', v.name ? 'font-semibold' : 'font-medium', !v.name && 'text-[hsl(var(--foreground))]/85')}>
                                {versionLabel(v)}
                              </span>
                            )}
                            <span className="shrink-0 text-[11px] text-[hsl(var(--muted-foreground))]">{formatVersionTime(v.createdAt)}</span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[hsl(var(--muted-foreground))]">
                            {authors.length ? authors.map(userChip) : <span>No edits recorded</span>}
                            {!v.diffable && <span className="rounded bg-[hsl(var(--muted))] px-1 text-[10px]">imported</span>}
                          </div>
                          {isSel && (
                            <div className="mt-2 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={() => setRenaming({ id: v.id, value: v.name ?? '' })}
                                className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2 py-0.5 text-[11px] hover:bg-[hsl(var(--background))]"
                              >
                                <Tag size={10} /> {v.name ? 'Rename' : 'Name'}
                              </button>
                              {canDelete(v) && confirmDeleteId !== v.id && (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(v.id)}
                                  className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2 py-0.5 text-[11px] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))]"
                                >
                                  <Trash2 size={10} /> Delete
                                </button>
                              )}
                              {confirmDeleteId === v.id && (
                                <>
                                  <span className="text-[11px]">Delete this version?</span>
                                  <button type="button" onClick={() => void doDelete(v.id)} disabled={busy} className="rounded-md bg-[hsl(var(--destructive))] px-2 py-0.5 text-[11px] font-medium text-white disabled:opacity-50">
                                    Delete
                                  </button>
                                  <button type="button" onClick={() => setConfirmDeleteId(null)} className="rounded-md px-2 py-0.5 text-[11px] hover:bg-[hsl(var(--background))]">
                                    Cancel
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
