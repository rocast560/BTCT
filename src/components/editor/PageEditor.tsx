import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Crepe } from '@milkdown/crepe';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { callCommand } from '@milkdown/utils';
import type { Editor } from '@milkdown/core';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame-dark.css';
import {
  Bold, Italic, Strikethrough, Code, Link as LinkIcon,
  ChevronDown, Highlighter, Keyboard,
} from 'lucide-react';
import {
  HIGHLIGHT_COLORS,
  highlightPlugin,
  setLastHighlightColor,
  toggleHighlightCommand,
  type HighlightColor,
} from '@/lib/highlight-plugin';
import { codeLanguages, codeSyntaxThemeExtension, codeLanguageAttrPlugin } from '@/lib/code-theme';
import {
  codeBlockShellDefault,
  codeFenceInputRule,
  getEditorKeybinds,
  inlineCodeNonInclusive,
  userKeybindsPlugin,
  focusLanguageKeymap,
} from '@/lib/editor-keybinds';
import { formatShortcut } from '@/lib/editor-prefs';
import { openLinkEditor } from '@/lib/link-editor';
import { notionTypingRules } from '@/lib/notion-typing';
import { TURN_INTO_ITEMS, turnIntoBlock, type TurnIntoTarget } from '@/lib/turn-into';
import { editorViewCtx } from '@milkdown/core';
import { createCodeBlockInputRule } from '@milkdown/preset-commonmark';
import { blockSelectPlugin } from '@/lib/block-select';
import { imageResizePlugin, imageResizableSchema, imageBlockResizableSchema } from '@/lib/image-resize';
import { assetImageSchema, assetImageView } from '@/lib/asset-image';
import { noteImagePastePlugin, noteImageContextPlugin } from '@/lib/note-image-paste';
import {
  DEFAULT_HEADER_LABELS,
  insertTable,
  TABLE_ICON,
  tableHeaderStatePlugin,
} from '@/lib/table-plugin';
import { KeybindsDialog } from '@/components/editor/KeybindsDialog';
import type { Ctx } from '@milkdown/ctx';
import { setActiveMilkdownEditor, registerPageEditor, unregisterPageEditor } from '@/lib/active-editor';
import { useAppStore } from '@/stores';
import { normalizePageContent } from '@/export/markdown';
import { getPageYContext } from '@/realtime/yjs-providers';
import { textKey } from '@/realtime/shared-doc';
import { useYTextInput } from '@/realtime/use-y-text';
import { graphNodeRepo } from '@/db/graph-node-repo';
import { graphEdgeRepo } from '@/db/graph-edge-repo';
import { pageRepo } from '@/db/page-repo';
import type {
  Page, GraphNode, GraphEdge,
  HostData, ServiceData, FindingData, PivotData,
} from '@/types';
import { Monitor, Key, Cog, Bug, ArrowRightLeft, ArrowLeft } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

/**
 * Minimal shape of Crepe's slash-menu builder.
 *
 * Crepe keeps `GroupBuilder`/`SlashMenuItem` internal to the package, so this
 * types just the two calls we make rather than reaching into its internals.
 */
interface TableMenuBuilder {
  getGroup: (key: string) => {
    addItem: (
      key: string,
      item: { label: string; icon: string; onRun: (ctx: Ctx) => void },
    ) => unknown;
  };
}

export function PageEditor({ pageId }: { pageId: string }) {
  // Read the page reactively from the shared store so remote edits
  // (title, slug, tags, icon, content) propagate to this view in real time.
  const storePage = useAppStore((s) => s.pages.find((p) => p.id === pageId) ?? null);
  // Only the node linked to this page matters; selecting the whole array
  // re-rendered every open editor on every node move.
  const linkedNodeFromStore = useAppStore((s) => s.graphNodes.find((n) => n.linkedPageId === pageId) ?? null);

  // Graph node pages are deliberately excluded from `loadPages()` so they
  // don't clutter the sidebar tree, which means double-clicking a graph
  // node opens a tab whose page id isn't in the store. Fetch it from the
  // repo so the editor can render. Subscribe to shared-doc page events
  // so remote edits to a graph page also flow into this fallback copy.
  const [fallbackPage, setFallbackPage] = useState<Page | null>(null);
  useEffect(() => {
    if (storePage) { setFallbackPage(null); return; }
    let cancelled = false;
    const refetch = () => {
      void pageRepo.getById(pageId).then((p) => {
        if (!cancelled) setFallbackPage(p ?? null);
      });
    };
    refetch();
    // Re-fetch only when the pages table identity actually changes. A bare
    // subscribe(refetch) fired on EVERY store write, including this
    // editor's own 400ms content save, doing a repo read + setState each
    // time while a graph-node page is open.
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.pages !== prev.pages) refetch();
    });
    return () => { cancelled = true; unsub(); };
  }, [pageId, storePage]);

  const page = storePage ?? fallbackPage;

  const linkedNode = useMemo<GraphNode | null>(() => {
    if (!page || !page.isGraphPage) return null;
    return linkedNodeFromStore;
  }, [page, linkedNodeFromStore]);

  // Fallback for graph nodes that haven't been loaded into the store yet
  // (e.g. opening a page tab before its graph tab). Hit the repo once and
  // hydrate via setLinkedNode-style local state only as a fallback.
  const [fallbackNode, setFallbackNode] = useState<GraphNode | null>(null);
  useEffect(() => {
    if (!page || !page.isGraphPage || linkedNode) {
      setFallbackNode(null);
      return;
    }
    let cancelled = false;
    void graphNodeRepo.getByLinkedPage(page.id).then((nodes) => {
      if (!cancelled && nodes.length > 0) setFallbackNode(nodes[0]!);
    });
    return () => { cancelled = true; };
  }, [page, linkedNode]);

  if (!page) return <div className="flex-1 p-4">Loading...</div>;

  return <PageEditorInner page={page} linkedNode={linkedNode ?? fallbackNode} />;
}

function PageEditorInner({ page, linkedNode }: {
  page: Page;
  linkedNode: GraphNode | null;
}) {
  const updatePage = useAppStore((s) => s.updatePage);
  const updateGraphNode = useAppStore((s) => s.updateGraphNode);
  const openTab = useAppStore((s) => s.openTab);
  const graphs = useAppStore((s) => s.graphs);
  const setPendingFocusNodeId = useAppStore((s) => s.setPendingFocusNodeId);
  const [editingSlug, setEditingSlug] = useState(false);

  // Bind the title and slug inputs to Y.Text CRDTs so concurrent edits
  // from multiple users merge character-by-character (insert/delete
  // deltas), exactly how Google Docs / Notion do it. The `mirrorTextsToRecords`
  // observer in shared-doc keeps page.title / page.slug in the JSON
  // snapshot in sync for sidebar / tab-label / search consumers.
  const [titleValue, setTitleValue, titleInputRef] = useYTextInput(
    textKey('page', page.id, 'title'),
    page.title,
  );
  const [slugYValue, setSlugYValue, slugInputRef] = useYTextInput(
    textKey('page', page.id, 'slug'),
    page.slug ?? '',
  );

  // The slug input also runs a sanitizer (lowercase, hyphens) over the
  // user's typed value before committing it to the CRDT.
  // The linked-node mirror is a full record rewrite plus a store-wide
  // reload per call, so it must not run per keystroke; the trailing value
  // after a pause is all the label needs.
  const labelSyncTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (labelSyncTimer.current != null) window.clearTimeout(labelSyncTimer.current);
  }, []);

  const handleTitleChange = (value: string) => {
    setTitleValue(value);
    // Mirror the new title onto the linked graph node's label Y.Text so
    // both stay in sync collaboratively.
    if (linkedNode) {
      // We do NOT have a Y.Text handle here: fall back to a straight
      // record patch for the linked node's label; users almost never
      // type into the page-title and the node-label simultaneously, and
      // the linked node also has its own Y.Text in NodeProperties.
      const nodeId = linkedNode.id;
      if (labelSyncTimer.current != null) window.clearTimeout(labelSyncTimer.current);
      labelSyncTimer.current = window.setTimeout(() => {
        labelSyncTimer.current = null;
        void updateGraphNode(nodeId, { label: value });
      }, 500);
    }
  };

  const handleSlugInputChange = (raw: string) => {
    const sanitized = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    setSlugYValue(sanitized);
  };
  const commitSlug = () => {
    setEditingSlug(false);
    const trimmed = slugYValue.replace(/(^-|-$)/g, '');
    if (trimmed !== slugYValue) setSlugYValue(trimmed);
  };

  // Keep a ref to the live markdown so the debounced persister always sees
  // the latest value without re-subscribing the Milkdown listener.
  const latestMarkdown = useRef<string>(normalizePageContent(page.content));
  const saveTimer = useRef<number | null>(null);

  // Shared ref to the Milkdown editor so the side format panel can dispatch
  // commands. `MarkdownEditor` assigns this on mount.
  const editorRef = useRef<Editor | null>(null);

  // The record copy is a cold-start/export mirror, not the live document
  // (that's the per-page Y.Doc), so it doesn't need a 400ms cadence. Each
  // save re-broadcasts the ENTIRE page record body to the server and every
  // peer, so: save after 2s of idle, with a 10s ceiling during continuous
  // typing, and the unmount flush below still catches page switches.
  const lastRecordSave = useRef(Date.now());
  const queueSave = useCallback(() => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    const deadline = lastRecordSave.current + 10_000;
    const delay = Math.max(0, Math.min(2000, deadline - Date.now()));
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      lastRecordSave.current = Date.now();
      void updatePage(page.id, { content: latestMarkdown.current });
    }, delay);
  }, [page.id, updatePage]);

  // Flush any pending save when the active page changes or the component unmounts.
  useEffect(() => {
    return () => {
      if (saveTimer.current != null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void updatePage(page.id, { content: latestMarkdown.current });
      }
    };
  }, [page.id, updatePage]);

  const discoveredAt = useMemo(() => {
    if (!page) return null;
    if (page.isGraphPage) return page.createdAt;
    return null;
  }, [page]);

  const handleNodeDataChange = useCallback((patch: Record<string, unknown>) => {
    if (!linkedNode) return;
    // Allow nested fields (e.g. host "Hostname") to also bump the node label
    // and page title by passing a magic `__label` key in the patch.
    const { __label, ...dataPatch } = patch as { __label?: unknown } & Record<string, unknown>;
    const newData = { ...linkedNode.data, ...dataPatch };
    const updates: Partial<GraphNode> = { data: newData };
    if (typeof __label === 'string') {
      updates.label = __label;
      void updatePage(page.id, { title: __label });
    }
    void updateGraphNode(linkedNode.id, updates);
  }, [linkedNode, updateGraphNode, updatePage, page.id]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        {/* Title */}
        <div className="mb-1 flex items-center gap-2">
          {linkedNode && (() => {
            const graph = graphs.find((g) => g.id === linkedNode.graphId);
            if (!graph) return null;
            return (
              <button
                type="button"
                onClick={() => {
                  setPendingFocusNodeId(linkedNode.id);
                  openTab({ id: uuidv4(), kind: 'graph', entityId: graph.id, title: graph.name });
                }}
                title={`Back to ${graph.name}`}
                className="flex shrink-0 items-center gap-1 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2.5 py-1 text-[10px] uppercase tracking-wider hover:bg-[hsl(var(--accent))]"
              >
                <ArrowLeft size={12} /> Narrative
              </button>
            );
          })()}
          <span className="text-2xl">{page.icon}</span>
          <input
            ref={titleInputRef}
            value={titleValue}
            onChange={(e) => handleTitleChange(e.target.value)}
            className="flex-1 bg-transparent text-3xl font-bold outline-none placeholder:text-[hsl(var(--muted-foreground))]"
            placeholder="Untitled"
          />
        </div>

        {/* Editable path / slug */}
        <div className="mb-2 flex items-center gap-1.5 text-xs text-[hsl(var(--muted-foreground))]">
          <span className="select-none opacity-60">/</span>
          {editingSlug ? (
            <input
              ref={slugInputRef}
              autoFocus
              value={slugYValue}
              onChange={(e) => handleSlugInputChange(e.target.value)}
              onBlur={commitSlug}
              onKeyDown={(e) => { if (e.key === 'Enter') commitSlug(); }}
              className="border-b border-[hsl(var(--border))] bg-transparent px-0.5 font-mono text-xs outline-none"
            />
          ) : (
            <button
              onClick={() => setEditingSlug(true)}
              className="rounded-sm px-0.5 font-mono hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
              title="Click to edit path"
            >
              {slugYValue || 'untitled'}
            </button>
          )}
        </div>

        {/* Tags */}
        <div className="mb-2 flex flex-wrap gap-1">
          {page.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-[hsl(var(--muted))] px-2.5 py-0.5 text-xs text-[hsl(var(--muted-foreground))]">
              {tag}
            </span>
          ))}
        </div>

        {/* Discovered at timestamp for graph pages */}
        {discoveredAt && (
          <div className="mb-4 text-xs text-[hsl(var(--muted-foreground))]">
            Discovered: {new Date(discoveredAt).toLocaleString()}
          </div>
        )}

        {/* Editable node data for graph-linked pages */}
        {linkedNode && (
          <NodeDataEditor node={linkedNode} onChange={handleNodeDataChange} />
        )}

        {/* Connected nodes for graph-linked pages */}
        {linkedNode && (
          <ConnectedNodes node={linkedNode} />
        )}

        {/* Milkdown (Crepe) editor: Obsidian-style live-preview markdown. */}
        <MilkdownProvider>
          <MarkdownEditor
            key={page.id}
            pageId={page.id}
            initialMarkdown={normalizePageContent(page.content)}
            editorRef={editorRef}
            onChange={(md) => {
              latestMarkdown.current = md;
              queueSave();
            }}
          />
        </MilkdownProvider>
      </div>
      {/* Floating format popup: only shown while text is selected. */}
      <FloatingFormatPanel editorRef={editorRef} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Milkdown (Crepe) editor wrapper.
//
// Crepe ships with Obsidian-style live preview: you type ``` to open a code
// block, `# ` for headings, `- [ ]` for checklists, `|` tables, etc., and
// rendering happens inline as you type. We mount a single Crepe instance
// per page id (hence the `key={page.id}` in the caller) and subscribe to
// the listener plugin's `markdownUpdated` event to drive persistence.
// ─────────────────────────────────────────────────────────────────────────
function MarkdownEditor({
  pageId,
  initialMarkdown,
  onChange,
  editorRef,
}: {
  pageId: string;
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  editorRef: React.MutableRefObject<Editor | null>;
}) {
  // onChange needs to stay fresh without forcing the editor to remount.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Resolve (or create) the per-page Y.Doc + IndexedDB persistence + cross-tab
  // BroadcastChannel sync. Cached so re-mounts don't lose in-memory state.
  const yctx = useMemo(() => getPageYContext(pageId), [pageId]);

  // The Crepe factory is intentionally synchronous: NO collab binding work
  // happens in here. The factory function runs every mount, but `crepe.create()`
  // (the call that actually builds the ProseMirror view) is async and Milkdown
  // does not give us its promise. If we tried to bind the Y.Doc inside the
  // factory we'd race against `create()` and on subsequent page revisits
  // (when `yctx.whenSynced` is already resolved) our binding would land on a
  // half-built editor and then `create()` would overwrite it with `defaultValue:
  // ''`. That's the source of "notes vanish and cursor stops syncing on revisit".
  //
  // Instead, we attach to the collab service from a useEffect that runs
  // strictly after `useEditor` reports `loading === false`, i.e. after the
  // editor is fully created.
  const { get, loading } = useEditor((root) => {
    const crepe = new Crepe({
      root,
      // When using collab the Y.Doc is the source of truth. Seeding only
      // happens once via applyTemplate in the effect below, so the editor
      // starts empty here.
      defaultValue: '',
      features: {
        [Crepe.Feature.Toolbar]: false,
      },
      featureConfigs: {
        // Notion-style ghost text on the current empty line instead of
        // Crepe's default "Please enter...".
        [Crepe.Feature.Placeholder]: {
          text: "Write, or type '/' for commands…",
          mode: 'block',
        },
        // Give code blocks the full language list (so the picker has options
        // and blocks get highlighted) plus our CSS-variable-driven syntax
        // theme and the "focus the language picker" keybind.
        [Crepe.Feature.CodeMirror]: {
          languages: codeLanguages,
          extensions: [codeSyntaxThemeExtension, focusLanguageKeymap],
        },
        // Two table variants in the slash menu. GFM always writes a header
        // row, so the difference is whether that row starts with content:
        // seeded column names render as a shaded header, a blank row renders
        // flat (see lib/table-plugin.ts).
        [Crepe.Feature.BlockEdit]: {
          // Notion's slash-menu vocabulary: filtering matches labels, so
          // "Bulleted list" answers /bullet and "Numbered list" answers /num
          // the way Notion users type them. H4-H6 leave the menu (Notion
          // stops at H3); typing #### etc. still works.
          textGroup: { h4: null, h5: null, h6: null },
          listGroup: {
            bulletList: { label: 'Bulleted list' },
            orderedList: { label: 'Numbered list' },
            taskList: { label: 'To-do list' },
          },
          advancedGroup: {
            // Replace Crepe's built-in entry so the shaded variant is the one
            // that seeds labels; the plain variant is added alongside it.
            table: null,
          },
          buildMenu: (builder: TableMenuBuilder) => {
            const advanced = builder.getGroup('advanced');
            advanced.addItem('table-header', {
              label: 'Table',
              icon: TABLE_ICON,
              onRun: (ctx) => insertTable(ctx, DEFAULT_HEADER_LABELS),
            });
            advanced.addItem('table-plain', {
              label: 'Plain table',
              icon: TABLE_ICON,
              onRun: (ctx) => insertTable(ctx, null),
            });
          },
        },
      },
    });
    // Commonmark's ``` rule stores the captured language verbatim ("" for a
    // bare fence), bypassing the schema default, and input rules are
    // first-match-wins, so the preset's copy has to go rather than be
    // shadowed. `remove()` is async by signature but drops the plugin from
    // the store synchronously while the editor is still idle, which it is
    // here: `create()` only runs after this factory returns.
    void crepe.editor.remove(createCodeBlockInputRule);
    crepe.editor
      .use(listener)
      .use(highlightPlugin)
      // `/code` and a bare ``` both default to shell; Notion typing
      // conversions ([] to-dos, " quotes); inline-code mark made
      // non-inclusive so the caret stays visible and code styling stops at
      // the closing backtick; per-account keybinds + backtick-wrap +
      // Ctrl+Shift+digit turn-into; Notion-style block selection (Esc);
      // per-language data attr.
      .use(codeBlockShellDefault)
      .use(codeFenceInputRule)
      .use(notionTypingRules)
      .use(inlineCodeNonInclusive)
      .use(userKeybindsPlugin)
      .use(blockSelectPlugin)
      .use(codeLanguageAttrPlugin)
      // Drag-to-resize images: a `width` attr on both the inline image and
      // Crepe's image block, plus a corner handle that writes it (see
      // lib/image-resize.ts).
      .use(imageResizableSchema)
      .use(imageBlockResizableSchema)
      .use(imageResizePlugin)
      // Asset-backed images: paste/drop uploads to the shared asset store and
      // inserts an asset_image node (blurrable non-destructively). See
      // lib/asset-image.ts + lib/note-image-paste.ts.
      .use(assetImageSchema)
      .use(assetImageView)
      .use(noteImagePastePlugin)
      .use(noteImageContextPlugin)
      .use(tableHeaderStatePlugin)
      .use(collab)
      .config((ctx) => {
        ctx.get(listenerCtx).markdownUpdated((_, md) => {
          onChangeRef.current(md);
        });
      });
    return crepe;
  }, [pageId]);

  // Once the editor is fully created AND the IndexedDB cache has loaded,
  // bind the Y.Doc and connect the collab service. On unmount, disconnect
  // cleanly so the awareness / cursor plugin handlers don't leak across
  // re-mounts (which would also break cursor sync for the next visit).
  useEffect(() => {
    if (loading) return;
    const editor = get();
    if (!editor) return;

    editorRef.current = editor;
    setActiveMilkdownEditor(editor);
    registerPageEditor(pageId, editor);
    let cancelled = false;

    void yctx.whenFullySynced.then(() => {
      if (cancelled || editorRef.current !== editor) return;
      try {
        editor.action((ctx) => {
          const service = ctx.get(collabServiceCtx);
          service.bindDoc(yctx.doc).setAwareness(yctx.awareness);

          // Custom remote-cursor renderer: matches the default y-prosemirror
          // structure (caret span + name tag div): just the user's name in
          // their color, no avatar.
          service.setOptions({
            yCursorOpts: {
              cursorBuilder: (user: { id?: number | string; name?: string; color?: string }) => {
                const color = user.color || '#ffa500';
                const name = user.name || 'Anonymous';
                const cursor = document.createElement('span');
                cursor.classList.add('ProseMirror-yjs-cursor');
                cursor.setAttribute('style', `border-color: ${color}`);
                // Tag with the user id so the follow feature can locate and
                // scroll a specific teammate's caret into view.
                if (user.id != null) cursor.setAttribute('data-user-id', String(user.id));
                const tag = document.createElement('div');
                tag.setAttribute('style', `background-color: ${color}`);
                tag.appendChild(document.createTextNode(name));
                cursor.appendChild(document.createTextNode('\u2060'));
                cursor.appendChild(tag);
                cursor.appendChild(document.createTextNode('\u2060'));
                return cursor;
              },
            },
          });

          // Only seed the Y.Doc the very first time we ever connect to this
          // fragment. Use an explicit fragment-length check rather than
          // Milkdown's default `textContent.length === 0` predicate, which
          // would wipe structural content (images, empty headings, partially-
          // typed checklists) on every revisit.
          const fragment = yctx.doc.getXmlFragment('prosemirror');
          if (fragment.length === 0) {
            service.applyTemplate(initialMarkdown, () => true);
          }

          service.connect();
        });
      } catch (err) {
        // Editor was destroyed mid-await; safe to ignore.
        if (import.meta.env.DEV) console.warn('[PageEditor] collab connect aborted:', err);
      }
    });

    return () => {
      cancelled = true;
      try {
        editor.action((ctx) => {
          const service = ctx.get(collabServiceCtx);
          service.disconnect();
        });
      } catch {
        /* editor already destroyed */
      }
      if (editorRef.current === editor) editorRef.current = null;
      unregisterPageEditor(pageId, editor);
      // Only clear the global reference if it's still pointing to *this*
      // editor, otherwise we'd stomp on a newer editor that registered
      // itself between this effect cleanup and a remount.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      setActiveMilkdownEditor(null);
    };
    // initialMarkdown is intentionally NOT in the deps: it would re-run this
    // effect on every keystroke (each save updates page.content → re-renders
    // PageEditorInner with a new initialMarkdown) which would tear down and
    // re-create the collab connection mid-typing. We only need the value
    // captured at first bind; the Y.Doc is authoritative after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, pageId, yctx]);

  useEffect(() => {
    return () => { editorRef.current = null; };
  }, [editorRef]);

  return (
    <div className="milkdown-host min-h-[400px]">
      <Milkdown />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Floating format toolbar: a Notion-style horizontal bar that appears just
// above the selection (below it when there's no headroom), centered on it.
// Layout mirrors Notion's edit bar: a "Turn into" dropdown showing the
// current block type, the inline marks with live active states, link, a
// highlight-color dropdown, and the keybinds gear. It's a portal overlay,
// so opening/closing it can never remount the editor (invariant #3).
// ─────────────────────────────────────────────────────────────────────────

interface ActiveFormats {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
  /** Label for the "Turn into" button (the selection's block type). */
  block: string;
}

const EMPTY_ACTIVE: ActiveFormats = {
  bold: false, italic: false, strike: false, code: false, link: false, block: 'Text',
};

function sameFormats(a: ActiveFormats, b: ActiveFormats): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike
    && a.code === b.code && a.link === b.link && a.block === b.block;
}

/** Read which marks cover the selection and what block type it sits in. */
function readActiveFormats(editor: Editor): ActiveFormats {
  const out = { ...EMPTY_ACTIVE };
  try {
    editor.action((ctx) => {
      const { state } = ctx.get(editorViewCtx);
      const { from, to, $from } = state.selection;
      const has = (name: string) => {
        const type = state.schema.marks[name];
        return type ? state.doc.rangeHasMark(from, to, type) : false;
      };
      out.bold = has('strong');
      out.italic = has('emphasis');
      out.strike = has('strike_through');
      out.code = has('inlineCode');
      out.link = has('link');
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.name === 'heading') { out.block = `Heading ${node.attrs.level}`; return; }
        if (node.type.name === 'code_block') { out.block = 'Code'; return; }
        if (node.type.name === 'blockquote') { out.block = 'Quote'; return; }
        if (node.type.name === 'list_item') {
          if (node.attrs.checked != null) { out.block = 'To-do list'; return; }
          out.block = $from.node(d - 1)?.type.name === 'ordered_list'
            ? 'Numbered list'
            : 'Bulleted list';
          return;
        }
      }
    });
  } catch {
    /* editor mid-teardown */
  }
  return out;
}

function FloatingFormatPanel({ editorRef }: { editorRef: React.MutableRefObject<Editor | null> }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState<ActiveFormats>(EMPTY_ACTIVE);
  const [openMenu, setOpenMenu] = useState<'turninto' | 'highlight' | null>(null);
  const [keybindsOpen, setKeybindsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setPos(null);
        setOpenMenu(null);
        return;
      }
      const anchor = sel.anchorNode;
      if (!anchor) { setPos(null); setOpenMenu(null); return; }
      const anchorEl = anchor.nodeType === Node.ELEMENT_NODE
        ? (anchor as Element)
        : anchor.parentElement;
      if (!anchorEl || !anchorEl.closest('.milkdown-host .ProseMirror')) {
        setPos(null);
        setOpenMenu(null);
        return;
      }
      // Don't hide when interacting with the panel itself.
      if (panelRef.current && panelRef.current.contains(anchorEl)) return;

      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setPos(null);
        setOpenMenu(null);
        return;
      }

      const panel = panelRef.current;
      const w = panel?.offsetWidth ?? 380;
      const h = panel?.offsetHeight ?? 38;
      const gap = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Notion placement: centered above the selection; flip below when the
      // selection starts too close to the top of the viewport.
      let top = rect.top - gap - h;
      if (top < 8) top = Math.min(vh - h - 8, rect.bottom + gap);
      const left = Math.min(vw - w - 8, Math.max(8, rect.left + rect.width / 2 - w / 2));
      setPos({ top, left });

      const editor = editorRef.current;
      if (editor) {
        const next = readActiveFormats(editor);
        setActive((prev) => (sameFormats(prev, next) ? prev : next));
      }
    };

    // Coalesce bursts (a scroll fires this per event, capture-phase, for
    // every scroller in the app; selectionchange fires per caret move) into
    // at most one layout-reading update per frame.
    let frame = 0;
    const onChange = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; update(); });
    };
    document.addEventListener('selectionchange', onChange);
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', onChange);
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
    };
  }, [editorRef]);

  const run = useCallback(<P,>(commandKey: string, payload?: P) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action(callCommand(commandKey, payload));
  }, [editorRef]);

  const applyTurnInto = useCallback((target: TurnIntoTarget) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action((ctx) => turnIntoBlock(ctx, target));
    setOpenMenu(null);
  }, [editorRef]);

  const applyHighlight = useCallback((color: HighlightColor | null) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (color) setLastHighlightColor(color);
    editor.action(callCommand(toggleHighlightCommand.key, color));
    setOpenMenu(null);
  }, [editorRef]);

  const kb = getEditorKeybinds();

  return (
    <>
      {pos && createPortal(
    <div
      ref={panelRef}
      className="fixed z-[60] flex items-center gap-0.5 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-1 shadow-xl animate-[hl-toolbar-in_0.08s_ease-out]"
      style={{ top: pos.top, left: pos.left }}
      role="toolbar"
      aria-label="Text formatting"
      // Preserve the editor selection while clicking inside the panel.
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* Turn into */}
      <div className="relative">
        <button
          type="button"
          title="Turn into"
          aria-label={`Turn into (current: ${active.block})`}
          onClick={() => setOpenMenu((m) => (m === 'turninto' ? null : 'turninto'))}
          className="flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]"
        >
          {active.block} <ChevronDown size={12} className="text-[hsl(var(--muted-foreground))]" />
        </button>
        {openMenu === 'turninto' && (
          <div className="absolute left-0 top-full z-10 mt-1 w-44 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-1 shadow-xl">
            <div className="px-2 pb-1 pt-0.5 text-[9px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
              Turn into
            </div>
            {TURN_INTO_ITEMS.map(({ target, label }) => (
              <button
                key={target}
                type="button"
                onClick={() => applyTurnInto(target)}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs hover:bg-[hsl(var(--accent))] ${
                  label === active.block ? 'text-[hsl(var(--primary))]' : ''
                }`}
              >
                {label}
                {label === active.block && <span aria-hidden>✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <ToolbarDivider />

      <ToolbarButton title={`Bold (${formatShortcut(kb.bold)})`} active={active.bold} onClick={() => run('ToggleStrong')}>
        <Bold size={14} />
      </ToolbarButton>
      <ToolbarButton title={`Italic (${formatShortcut(kb.italic)})`} active={active.italic} onClick={() => run('ToggleEmphasis')}>
        <Italic size={14} />
      </ToolbarButton>
      <ToolbarButton title={`Strikethrough (${formatShortcut(kb.strikethrough)})`} active={active.strike} onClick={() => run('ToggleStrikeThrough')}>
        <Strikethrough size={14} />
      </ToolbarButton>
      <ToolbarButton title={`Inline code (${formatShortcut(kb.inlineCode)})`} active={active.code} onClick={() => run('ToggleInlineCode')}>
        <Code size={14} />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton
        title={`Link (${formatShortcut(kb.link)})`}
        active={active.link}
        onClick={() => { const editor = editorRef.current; if (editor) openLinkEditor(editor); }}
      >
        <LinkIcon size={14} />
      </ToolbarButton>

      {/* Highlight color */}
      <div className="relative">
        <ToolbarButton
          title={`Highlight (${formatShortcut(kb.highlight)} re-applies the last color)`}
          active={openMenu === 'highlight'}
          onClick={() => setOpenMenu((m) => (m === 'highlight' ? null : 'highlight'))}
        >
          <Highlighter size={14} />
        </ToolbarButton>
        {openMenu === 'highlight' && (
          <div className="absolute right-0 top-full z-10 mt-1 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-2 shadow-xl">
            <div className="pb-1 text-[9px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
              Highlight
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {HIGHLIGHT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  title={`Highlight ${color}`}
                  aria-label={`Highlight ${color}`}
                  onClick={() => applyHighlight(color)}
                  className="hl-swatch"
                  style={{ backgroundColor: swatchCssColor(color) }}
                />
              ))}
              <button
                type="button"
                title="Remove highlight"
                aria-label="Remove highlight"
                onClick={() => applyHighlight(null)}
                className="hl-swatch hl-swatch--clear"
              />
            </div>
          </div>
        )}
      </div>

      <ToolbarDivider />

      <ToolbarButton title="Customize keybinds" onClick={() => setKeybindsOpen(true)}>
        <Keyboard size={13} />
      </ToolbarButton>
    </div>,
    document.body,
      )}
      {keybindsOpen && <KeybindsDialog onClose={() => setKeybindsOpen(false)} />}
    </>
  );
}

function ToolbarDivider() {
  return <div aria-hidden className="mx-0.5 h-4 w-px bg-[hsl(var(--border))]" />;
}

function ToolbarButton({ title, active, onClick, children }: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active ?? false}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md hover:bg-[hsl(var(--accent))] ${
        active
          ? 'bg-[hsl(var(--accent))] text-[hsl(var(--primary))]'
          : 'text-[hsl(var(--foreground))]'
      }`}
    >
      {children}
    </button>
  );
}

function swatchCssColor(color: HighlightColor): string {
  switch (color) {
    case 'yellow': return 'rgba(250, 204,  21, 0.65)';
    case 'green':  return 'rgba( 74, 222, 128, 0.60)';
    case 'blue':   return 'rgba( 96, 165, 250, 0.65)';
    case 'pink':   return 'rgba(244, 114, 182, 0.65)';
    case 'orange': return 'rgba(251, 146,  60, 0.70)';
    case 'purple': return 'rgba(192, 132, 252, 0.65)';
    case 'red':    return 'rgba(248, 113, 113, 0.65)';
  }
}

// ── Inline node data editor (shown on graph-linked pages) ──


const NODE_TYPE_LABELS: Record<string, string> = {
  host: 'Host',
  service: 'Service',
  finding: 'Finding',
  pivot: 'Pivot',
};

// Per-severity pill styling for the finding-properties header: kept in
// sync with FindingNode's severityConfig so the same medium/high/etc.
// badge appears on the graph card AND in the editor header.
const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-[hsl(var(--status-purple))]/25 text-[hsl(var(--status-purple))]',
  high:     'bg-[hsl(var(--status-red))]/25 text-[hsl(var(--status-red))]',
  medium:   'bg-[hsl(var(--status-amber))]/25 text-[hsl(var(--status-amber))]',
  low:      'bg-[hsl(var(--status-green))]/25 text-[hsl(var(--status-green))]',
  info:     'bg-[hsl(var(--status-blue))]/25 text-[hsl(var(--status-blue))]',
};

function NodeDataEditor({ node, onChange }: { node: GraphNode; onChange: (patch: Record<string, unknown>) => void }) {
  const findingData = node.type === 'finding' ? (node.data as FindingData | undefined) : null;
  const severity = findingData?.severity ?? null;
  return (
    <div className="mb-6 overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="flex items-center gap-3 border-b border-[hsl(var(--border))] px-4 py-3">
        {severity && (
          <span className={`rounded-full px-3.5 py-1 text-xl font-bold uppercase tracking-wide ${SEVERITY_BADGE[severity] ?? SEVERITY_BADGE['info']}`}>
            {severity}
            {findingData && findingData.cvss > 0 ? ` · ${findingData.cvss.toFixed(1)}` : ''}
          </span>
        )}
        <span className="text-2xl font-bold uppercase tracking-wider text-[hsl(var(--foreground))]">
          {NODE_TYPE_LABELS[node.type] ?? node.type} Properties
        </span>
      </div>
      <div className="grid gap-3 px-4 py-3">
        {node.type === 'host' && <HostFields data={(node.data ?? {}) as HostData} onChange={onChange} />}
        {node.type === 'service' && <ServiceFields data={(node.data ?? {}) as ServiceData} onChange={onChange} />}
        {node.type === 'finding' && <FindingFields data={(node.data ?? {}) as FindingData} onChange={onChange} />}
        {node.type === 'pivot' && <PivotFields data={(node.data ?? {}) as PivotData} onChange={onChange} />}
      </div>
    </div>
  );
}

function InlineField({ label, value, onChange, mono }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <label className="w-28 shrink-0 text-xs text-[hsl(var(--muted-foreground))]">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`flex-1 border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none focus:border-[hsl(var(--primary))] ${mono ? 'font-mono' : ''}`}
      />
    </div>
  );
}

function HostFields({ data, onChange }: { data: HostData; onChange: (p: Record<string, unknown>) => void }) {
  const [portsText, setPortsText] = useState((data.openPorts ?? []).join(', '));
  const commitPorts = () => {
    const parsed = portsText.split(',').map((p) => parseInt(p.trim(), 10)).filter((n) => !isNaN(n));
    onChange({ openPorts: parsed });
  };
  return (
    <>
      <InlineField
        label="Hostname"
        value={data.hostname ?? ''}
        onChange={(v) => onChange({ hostname: v, __label: v })}
      />
      <InlineField label="IP Address" value={data.ip ?? ''} onChange={(v) => onChange({ ip: v })} mono />
      <InlineField label="OS" value={data.os ?? ''} onChange={(v) => onChange({ os: v })} />
      <div className="flex items-center gap-3">
        <label className="w-28 shrink-0 text-xs text-[hsl(var(--muted-foreground))]">Open Ports</label>
        <input
          value={portsText}
          onChange={(e) => setPortsText(e.target.value)}
          onBlur={commitPorts}
          onKeyDown={(e) => { if (e.key === 'Enter') commitPorts(); }}
          placeholder="80, 443, 8080"
          className="flex-1 border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 font-mono text-sm outline-none focus:border-[hsl(var(--primary))]"
        />
      </div>
    </>
  );
}

function ServiceFields({ data, onChange }: { data: ServiceData; onChange: (p: Record<string, unknown>) => void }) {
  const [cvesText, setCvesText] = useState((data.cves ?? []).join(', '));
  const commitCves = () => {
    onChange({ cves: cvesText.split(',').map((s) => s.trim()).filter(Boolean) });
  };
  return (
    <>
      <InlineField label="Service Name" value={data.name ?? ''} onChange={(v) => onChange({ name: v })} />
      <InlineField label="Version" value={data.version ?? ''} onChange={(v) => onChange({ version: v })} />
      <InlineField label="Port" value={String(data.port ?? 0)} onChange={(v) => onChange({ port: parseInt(v, 10) || 0 })} mono />
      <div className="flex items-center gap-3">
        <label className="w-28 shrink-0 text-xs text-[hsl(var(--muted-foreground))]">CVEs</label>
        <input
          value={cvesText}
          onChange={(e) => setCvesText(e.target.value)}
          onBlur={commitCves}
          onKeyDown={(e) => { if (e.key === 'Enter') commitCves(); }}
          placeholder="CVE-2024-1234, CVE-2024-5678"
          className="flex-1 border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 font-mono text-sm outline-none focus:border-[hsl(var(--primary))]"
        />
      </div>
    </>
  );
}

function FindingFields({ data, onChange }: { data: FindingData; onChange: (p: Record<string, unknown>) => void }) {
  const [cvssText, setCvssText] = useState(String(data.cvss ?? 0));
  const [cvssFocused, setCvssFocused] = useState(false);
  const [hostsText, setHostsText] = useState((data.hosts ?? []).join(', '));
  const [refsText, setRefsText] = useState((data.references ?? []).join('\n'));
  useEffect(() => { if (!cvssFocused) setCvssText(String(data.cvss ?? 0)); }, [data.cvss, cvssFocused]);
  useEffect(() => { setHostsText((data.hosts ?? []).join(', ')); }, [data.hosts]);
  useEffect(() => { setRefsText((data.references ?? []).join('\n')); }, [data.references]);
  const commitCvss = () => {
    setCvssFocused(false);
    let num = parseFloat(cvssText);
    if (isNaN(num)) num = 0;
    num = Math.max(0, Math.min(10, num));
    setCvssText(String(num));
    onChange({ cvss: num });
  };
  const commitHosts = () => onChange({ hosts: hostsText.split(',').map((s) => s.trim()).filter(Boolean) });
  const commitRefs = () => onChange({ references: refsText.split('\n').map((s) => s.trim()).filter(Boolean) });
  const sevOptions: Array<FindingData['severity']> = ['critical', 'high', 'medium', 'low', 'info'];
  return (
    <>
      <InlineField label="Title" value={data.title ?? ''} onChange={(v) => onChange({ title: v })} />
      <InlineSelect label="Severity" value={data.severity ?? 'medium'} options={sevOptions} onChange={(v) => onChange({ severity: v })} />
      <div className="flex items-center gap-3">
        <label className="w-28 shrink-0 text-xs text-[hsl(var(--muted-foreground))]">CVSS</label>
        <input
          value={cvssText}
          onChange={(e) => setCvssText(e.target.value)}
          onFocus={() => setCvssFocused(true)}
          onBlur={commitCvss}
          onKeyDown={(e) => { if (e.key === 'Enter') commitCvss(); }}
          className="flex-1 border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 font-mono text-sm outline-none focus:border-[hsl(var(--primary))]"
        />
      </div>
      <InlineField label="CVSS Vector" value={data.cvssVector ?? ''} onChange={(v) => onChange({ cvssVector: v })} mono />
      <InlineSelect label="Likelihood" value={data.likelihood ?? 'info'} options={sevOptions} onChange={(v) => onChange({ likelihood: v })} />
      <InlineSelect label="Impact" value={data.impact ?? 'info'} options={sevOptions} onChange={(v) => onChange({ impact: v })} />
      <InlineTextArea label="Description" value={data.description ?? ''} onChange={(v) => onChange({ description: v })} rows={3} />
      <InlineTextArea label="Business Impact" value={data.businessImpact ?? ''} onChange={(v) => onChange({ businessImpact: v })} rows={2} />
      <InlineTextArea label="Exploit Steps" value={data.exploitSteps ?? ''} onChange={(v) => onChange({ exploitSteps: v })} rows={4} mono />
      <InlineField label="MITRE ATT&CK" value={data.mitreAttack ?? ''} onChange={(v) => onChange({ mitreAttack: v })} />
      <InlineField label="MITRE Mitigation" value={data.mitreMitigation ?? ''} onChange={(v) => onChange({ mitreMitigation: v })} />
      <InlineTextArea label="Remediation" value={data.remediation ?? ''} onChange={(v) => onChange({ remediation: v })} rows={3} />
      <div className="flex items-center gap-3">
        <label className="w-28 shrink-0 text-xs text-[hsl(var(--muted-foreground))]">Hosts</label>
        <input
          value={hostsText}
          onChange={(e) => setHostsText(e.target.value)}
          onBlur={commitHosts}
          onKeyDown={(e) => { if (e.key === 'Enter') commitHosts(); }}
          placeholder="10.0.0.5, web01"
          className="flex-1 border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 font-mono text-sm outline-none focus:border-[hsl(var(--primary))]"
        />
      </div>
      <InlineField label="Service" value={data.service ?? ''} onChange={(v) => onChange({ service: v })} />
      <div className="flex items-start gap-3">
        <label className="w-28 shrink-0 pt-1 text-xs text-[hsl(var(--muted-foreground))]">References</label>
        <textarea
          value={refsText}
          onChange={(e) => setRefsText(e.target.value)}
          onBlur={commitRefs}
          placeholder="One URL or reference per line"
          rows={3}
          className="flex-1 border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 font-mono text-sm outline-none focus:border-[hsl(var(--primary))] resize-y"
        />
      </div>
    </>
  );
}

function InlineSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-3">
      <label className="w-28 shrink-0 text-xs text-[hsl(var(--muted-foreground))]">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="flex-1 border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none focus:border-[hsl(var(--primary))] capitalize"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt.charAt(0).toUpperCase() + opt.slice(1)}</option>
        ))}
      </select>
    </div>
  );
}

function InlineTextArea({ label, value, onChange, rows = 3, mono }: { label: string; value: string; onChange: (v: string) => void; rows?: number; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <label className="w-28 shrink-0 pt-1 text-xs text-[hsl(var(--muted-foreground))]">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className={`flex-1 border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none focus:border-[hsl(var(--primary))] resize-y ${mono ? 'font-mono' : ''}`}
      />
    </div>
  );
}

function PivotFields({ data, onChange }: { data: PivotData; onChange: (p: Record<string, unknown>) => void }) {
  return (
    <div className="flex items-start gap-3">
      <label className="w-28 shrink-0 pt-1 text-xs text-[hsl(var(--muted-foreground))]">Description</label>
      <textarea
        value={data.description ?? ''}
        onChange={(e) => onChange({ description: e.target.value })}
        className="flex-1 border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none focus:border-[hsl(var(--primary))]"
        rows={3}
      />
    </div>
  );
}

// ── Connected nodes section (shown below node properties on graph-linked pages) ──

const NODE_ICON: Record<string, React.ReactNode> = {
  host: <Monitor size={14} className="text-neutral-400" />,
  credential: <Key size={14} className="text-neutral-400" />,
  service: <Cog size={14} className="text-neutral-400" />,
  finding: <Bug size={14} className="text-red-400" />,
  pivot: <ArrowRightLeft size={14} className="text-neutral-400" />,
};

const NODE_BORDER_COLOR: Record<string, string> = {
  host: 'border-neutral-600/60 hover:border-neutral-500/80',
  credential: 'border-neutral-600/60 hover:border-neutral-500/80',
  service: 'border-neutral-600/60 hover:border-neutral-500/80',
  finding: 'border-red-800/60 hover:border-red-600/80',
  pivot: 'border-neutral-600/60 hover:border-neutral-500/80',
};

interface ConnectedNodeInfo {
  node: GraphNode;
  edgeLabel: string;
  direction: 'outgoing' | 'incoming';
}

function ConnectedNodes({ node }: { node: GraphNode }) {
  const [connected, setConnected] = useState<ConnectedNodeInfo[]>([]);
  const openTab = useAppStore((s) => s.openTab);

  useEffect(() => {
    void (async () => {
      // Get all edges for this graph
      const edges: GraphEdge[] = await graphEdgeRepo.getByGraph(node.graphId);
      // Find edges connected to this node
      const relevant = edges.filter(
        (e) => e.sourceNodeId === node.id || e.targetNodeId === node.id,
      );
      if (relevant.length === 0) {
        setConnected([]);
        return;
      }
      // Collect unique connected node IDs
      const peerIds = new Set<string>();
      const edgeMap = new Map<string, { label: string; direction: 'outgoing' | 'incoming' }>();
      for (const e of relevant) {
        if (e.sourceNodeId === node.id) {
          peerIds.add(e.targetNodeId);
          edgeMap.set(e.targetNodeId, { label: e.label, direction: 'outgoing' });
        } else {
          peerIds.add(e.sourceNodeId);
          edgeMap.set(e.sourceNodeId, { label: e.label, direction: 'incoming' });
        }
      }
      // Fetch each connected node
      const results: ConnectedNodeInfo[] = [];
      for (const peerId of peerIds) {
        const peerNode = await graphNodeRepo.getById(peerId);
        if (peerNode) {
          const info = edgeMap.get(peerId)!;
          results.push({ node: peerNode, edgeLabel: info.label, direction: info.direction });
        }
      }
      setConnected(results);
    })();
  }, [node.id, node.graphId]);

  if (connected.length === 0) return null;

  const handleClick = (target: GraphNode) => {
    openTab({ id: uuidv4(), kind: 'page', entityId: target.linkedPageId, title: target.label });
  };

  return (
    <div className="mb-6 overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="flex items-center gap-2 border-b border-[hsl(var(--border))] px-4 py-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
          Connected Nodes
        </span>
        <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
          ({connected.length})
        </span>
      </div>
      <div className="grid gap-2 px-4 py-3 sm:grid-cols-2">
        {connected.map((c) => (
          <button
            key={c.node.id}
            onClick={() => handleClick(c.node)}
            className={`flex items-start gap-3 rounded-lg border bg-[hsl(var(--background))] p-3 text-left transition-colors hover:bg-[hsl(var(--accent))] ${NODE_BORDER_COLOR[c.node.type] ?? 'border-[hsl(var(--border))]'}`}
          >
            <div className="mt-0.5 shrink-0">{NODE_ICON[c.node.type]}</div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold truncate">{c.node.label}</div>
              <div className="mt-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">
                {c.direction === 'outgoing' ? '→' : '←'} {c.edgeLabel}
              </div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                {c.node.type}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
