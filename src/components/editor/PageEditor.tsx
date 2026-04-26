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
  Heading1, Heading2, Heading3,
  List, ListOrdered, Quote,
} from 'lucide-react';
import {
  HIGHLIGHT_COLORS,
  highlightPlugin,
  toggleHighlightCommand,
  type HighlightColor,
} from '@/lib/highlight-plugin';
import { useAppStore } from '@/stores';
import { pageRepo } from '@/db';
import { normalizePageContent } from '@/export/markdown';
import { getPageYContext } from '@/realtime/yjs-providers';
import { graphNodeRepo } from '@/db/graph-node-repo';
import { graphEdgeRepo } from '@/db/graph-edge-repo';
import type {
  Page, GraphNode, GraphEdge,
  HostData, ServiceData, FindingData, PivotData,
} from '@/types';
import { Monitor, Key, Cog, Bug, ArrowRightLeft } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

export function PageEditor({ pageId }: { pageId: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [linkedNode, setLinkedNode] = useState<GraphNode | null>(null);

  useEffect(() => {
    void pageRepo.getById(pageId).then((p) => {
      if (p) {
        setPage(p);
        // If this is a graph page, find the linked node
        if (p.isGraphPage) {
          void graphNodeRepo.getByLinkedPage(p.id).then((nodes) => {
            if (nodes.length > 0) setLinkedNode(nodes[0]!);
          });
        } else {
          setLinkedNode(null);
        }
      }
    });
  }, [pageId]);

  if (!page) return <div className="flex-1 p-4">Loading...</div>;

  return <PageEditorInner page={page} linkedNode={linkedNode} setLinkedNode={setLinkedNode} />;
}

function PageEditorInner({ page, linkedNode, setLinkedNode }: {
  page: Page;
  linkedNode: GraphNode | null;
  setLinkedNode: React.Dispatch<React.SetStateAction<GraphNode | null>>;
}) {
  const updatePage = useAppStore((s) => s.updatePage);
  const updateGraphNode = useAppStore((s) => s.updateGraphNode);
  const [titleValue, setTitleValue] = useState(page.title);
  const [slugValue, setSlugValue] = useState(page.slug ?? '');
  const [editingSlug, setEditingSlug] = useState(false);

  // Keep a ref to the live markdown so the debounced persister always sees
  // the latest value without re-subscribing the Milkdown listener.
  const latestMarkdown = useRef<string>(normalizePageContent(page.content));
  const saveTimer = useRef<number | null>(null);

  // Shared ref to the Milkdown editor so the side format panel can dispatch
  // commands. `MarkdownEditor` assigns this on mount.
  const editorRef = useRef<Editor | null>(null);

  const queueSave = useCallback(() => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void updatePage(page.id, { content: latestMarkdown.current });
    }, 400);
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

  const handleTitleChange = (value: string) => {
    setTitleValue(value);
    void updatePage(page.id, { title: value });
    if (linkedNode) {
      void updateGraphNode(linkedNode.id, { label: value });
      setLinkedNode((prev) => prev ? { ...prev, label: value } : prev);
    }
  };

  const handleNodeDataChange = useCallback((patch: Record<string, unknown>) => {
    if (!linkedNode) return;
    // Allow nested fields (e.g. host "Hostname") to also bump the node label
    // and page title by passing a magic `__label` key in the patch.
    const { __label, ...dataPatch } = patch as { __label?: unknown } & Record<string, unknown>;
    const newData = { ...linkedNode.data, ...dataPatch };
    const updates: Partial<GraphNode> = { data: newData };
    if (typeof __label === 'string') {
      updates.label = __label;
      setTitleValue(__label);
      void updatePage(page.id, { title: __label });
    }
    void updateGraphNode(linkedNode.id, updates);
    setLinkedNode((prev) => prev ? { ...prev, ...updates, data: newData } : prev);
  }, [linkedNode, updateGraphNode, updatePage, page.id, setLinkedNode]);

  const handleSlugChange = (value: string) => {
    const sanitized = value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    setSlugValue(sanitized);
  };

  const commitSlug = () => {
    setEditingSlug(false);
    const trimmed = slugValue.replace(/(^-|-$)/g, '');
    setSlugValue(trimmed);
    void updatePage(page.id, { slug: trimmed });
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        {/* Title */}
        <div className="mb-1 flex items-center gap-2">
          <span className="text-2xl">{page.icon}</span>
          <input
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
              autoFocus
              value={slugValue}
              onChange={(e) => handleSlugChange(e.target.value)}
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
              {slugValue || 'untitled'}
            </button>
          )}
        </div>

        {/* Tags */}
        <div className="mb-2 flex flex-wrap gap-1">
          {page.tags.map((tag) => (
            <span key={tag} className="bg-[hsl(var(--muted))] px-2 py-0.5 text-xs">
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

        {/* Milkdown (Crepe) editor — Obsidian-style live-preview markdown. */}
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
      {/* Floating format popup — only shown while text is selected. */}
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

  useEditor((root) => {
    const crepe = new Crepe({
      root,
      // When using collab, the Y.Doc is the source of truth. We seed the
      // doc from `initialMarkdown` via `applyTemplate` below, so Crepe
      // should start with an empty document.
      defaultValue: '',
      // Disable the floating bold/italic bubble — we render a side panel
      // on the right of the page instead so the controls don't overlap
      // the text the user is selecting.
      features: {
        [Crepe.Feature.Toolbar]: false,
      },
    });
    crepe.editor
      .use(listener)
      .use(highlightPlugin)
      .use(collab)
      .config((ctx) => {
        ctx.get(listenerCtx).markdownUpdated((_, md) => {
          onChangeRef.current(md);
        });
      });
    editorRef.current = crepe.editor;

    // Wire up collaboration once IndexedDB persistence has loaded any
    // previously-saved state. If the Y.Doc is empty after that, seed it
    // from the markdown stored in Dexie via `applyTemplate` (the second
    // argument's default is "doc is empty").
    void yctx.whenSynced.then(() => {
      if (editorRef.current !== crepe.editor) return; // editor was replaced
      crepe.editor.action((ctx) => {
        const service = ctx.get(collabServiceCtx);
        service
          .bindDoc(yctx.doc)
          .setAwareness(yctx.awareness)
          .applyTemplate(initialMarkdown)
          .connect();
      });
    });

    return crepe;
  }, [pageId]);

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
// Floating format panel — portal-mounted popup that appears only while the
// user has a non-empty text selection inside the editor. Positioned to the
// right of the selection when there's room, otherwise to the left, flipped
// above/below as needed so it never covers the selected text.
// ─────────────────────────────────────────────────────────────────────────
function FloatingFormatPanel({ editorRef }: { editorRef: React.MutableRefObject<Editor | null> }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setPos(null);
        return;
      }
      const anchor = sel.anchorNode;
      if (!anchor) { setPos(null); return; }
      const anchorEl = anchor.nodeType === Node.ELEMENT_NODE
        ? (anchor as Element)
        : anchor.parentElement;
      if (!anchorEl || !anchorEl.closest('.milkdown-host .ProseMirror')) {
        setPos(null);
        return;
      }
      // Don't hide when interacting with the panel itself.
      if (panelRef.current && panelRef.current.contains(anchorEl)) return;

      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setPos(null);
        return;
      }

      const panel = panelRef.current;
      const w = panel?.offsetWidth ?? 200;
      const h = panel?.offsetHeight ?? 160;
      const gap = 12;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Prefer right of the selection, then left, then below, then above.
      let left: number;
      let top: number;
      if (rect.right + gap + w <= vw - 8) {
        left = rect.right + gap;
        top = Math.min(vh - h - 8, Math.max(8, rect.top));
      } else if (rect.left - gap - w >= 8) {
        left = rect.left - gap - w;
        top = Math.min(vh - h - 8, Math.max(8, rect.top));
      } else if (rect.bottom + gap + h <= vh - 8) {
        top = rect.bottom + gap;
        left = Math.min(vw - w - 8, Math.max(8, rect.left + rect.width / 2 - w / 2));
      } else {
        top = Math.max(8, rect.top - gap - h);
        left = Math.min(vw - w - 8, Math.max(8, rect.left + rect.width / 2 - w / 2));
      }
      setPos({ top, left });
    };

    const onChange = () => requestAnimationFrame(update);
    document.addEventListener('selectionchange', onChange);
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    return () => {
      document.removeEventListener('selectionchange', onChange);
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
    };
  }, []);

  const run = useCallback(<P,>(commandKey: string, payload?: P) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action(callCommand(commandKey, payload));
  }, [editorRef]);

  const applyHighlight = useCallback((color: HighlightColor | null) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.action(callCommand(toggleHighlightCommand.key, color));
  }, [editorRef]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-[60] flex flex-col gap-3 border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-2 shadow-xl animate-[hl-toolbar-in_0.08s_ease-out]"
      style={{ top: pos.top, left: pos.left, width: 200 }}
      role="toolbar"
      aria-label="Text formatting"
      // Preserve the editor selection while clicking inside the panel.
      onMouseDown={(e) => e.preventDefault()}
    >
      <FormatGroup label="Text">
        <FormatButton title="Bold (Ctrl+B)"   onClick={() => run('ToggleStrong')}><Bold size={14} /></FormatButton>
        <FormatButton title="Italic (Ctrl+I)" onClick={() => run('ToggleEmphasis')}><Italic size={14} /></FormatButton>
        <FormatButton title="Strikethrough"   onClick={() => run('ToggleStrikeThrough')}><Strikethrough size={14} /></FormatButton>
        <FormatButton title="Inline code"     onClick={() => run('ToggleInlineCode')}><Code size={14} /></FormatButton>
        <FormatButton title="Link"            onClick={() => {
          const href = window.prompt('Link URL');
          if (href) run('ToggleLink', { href, title: '' });
        }}><LinkIcon size={14} /></FormatButton>
      </FormatGroup>

      <FormatGroup label="Block">
        <FormatButton title="Heading 1"       onClick={() => run('WrapInHeading', 1)}><Heading1 size={14} /></FormatButton>
        <FormatButton title="Heading 2"       onClick={() => run('WrapInHeading', 2)}><Heading2 size={14} /></FormatButton>
        <FormatButton title="Heading 3"       onClick={() => run('WrapInHeading', 3)}><Heading3 size={14} /></FormatButton>
        <FormatButton title="Bulleted list"   onClick={() => run('WrapInBulletList')}><List size={14} /></FormatButton>
        <FormatButton title="Numbered list"   onClick={() => run('WrapInOrderedList')}><ListOrdered size={14} /></FormatButton>
        <FormatButton title="Quote"           onClick={() => run('WrapInBlockquote')}><Quote size={14} /></FormatButton>
      </FormatGroup>

      <div>
        <div className="mb-1 text-[9px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Highlight</div>
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
    </div>,
    document.body,
  );
}

function FormatGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[9px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">{label}</div>
      <div className="grid grid-cols-5 gap-1">{children}</div>
    </div>
  );
}

function FormatButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]"
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

function NodeDataEditor({ node, onChange }: { node: GraphNode; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="mb-6 border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="flex items-center gap-2 border-b border-[hsl(var(--border))] px-4 py-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
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
    <div className="mb-6 border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
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
            className={`flex items-start gap-3 border bg-[hsl(var(--background))] p-3 text-left transition-colors hover:bg-[hsl(var(--accent))] ${NODE_BORDER_COLOR[c.node.type] ?? 'border-[hsl(var(--border))]'}`}
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
