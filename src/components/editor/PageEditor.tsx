import { useEffect, useState, useMemo, useCallback } from 'react';
import { BlockNoteSchema, createCodeBlockSpec } from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/mantine/style.css';
import { useAppStore } from '@/stores';
import { pageRepo } from '@/db';
import { graphNodeRepo } from '@/db/graph-node-repo';
import { graphEdgeRepo } from '@/db/graph-edge-repo';
import type {
  Page, PartialBlockContent, GraphNode, GraphEdge,
  HostData, ServiceData, FindingData, PivotData,
} from '@/types';
import { createHighlighter } from 'shiki';
import { Monitor, Key, Cog, Bug, ArrowRightLeft } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

const schema = BlockNoteSchema.create().extend({
  blockSpecs: {
    codeBlock: createCodeBlockSpec({
      indentLineWithTab: true,
      defaultLanguage: 'bash',
      supportedLanguages: {
        bash: { name: 'Bash', aliases: ['sh', 'shell'] },
        python: { name: 'Python', aliases: ['py'] },
        yaml: { name: 'YAML', aliases: ['yml'] },
        json: { name: 'JSON' },
      },
      createHighlighter: () =>
        createHighlighter({
          themes: ['dark-plus', 'light-plus'],
          langs: ['bash', 'python', 'yaml', 'json'],
        }),
    }),
  },
});

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
  const darkMode = useAppStore((s) => s.darkMode);
  const [titleValue, setTitleValue] = useState(page.title);
  const [slugValue, setSlugValue] = useState(page.slug ?? '');
  const [editingSlug, setEditingSlug] = useState(false);

  const editor = useCreateBlockNote({
    schema,
    uploadFile: async (file: File) => {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    },
    initialContent: page.content && (page.content as PartialBlockContent).length > 0
      ? (page.content as Parameters<typeof useCreateBlockNote>[0] extends { initialContent?: infer I } ? I : never)
      : undefined,
  }, [page.id]);

  const discoveredAt = useMemo(() => {
    if (!page) return null;
    // Check if this is a graph-linked page
    if (page.isGraphPage) return page.createdAt;
    return null;
  }, [page]);

  const handleTitleChange = (value: string) => {
    setTitleValue(value);
    void updatePage(page.id, { title: value });
    // Sync label to linked graph node
    if (linkedNode) {
      void updateGraphNode(linkedNode.id, { label: value });
      setLinkedNode((prev) => prev ? { ...prev, label: value } : prev);
    }
  };

  const handleNodeDataChange = useCallback((patch: Record<string, unknown>) => {
    if (!linkedNode) return;
    const newData = { ...linkedNode.data, ...patch };
    void updateGraphNode(linkedNode.id, { data: newData });
    setLinkedNode((prev) => prev ? { ...prev, data: newData } : prev);
  }, [linkedNode, updateGraphNode]);

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

  const handleContentChange = () => {
    const blocks = editor.document;
    void updatePage(page.id, { content: blocks as unknown as PartialBlockContent });
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

        {/* BlockNote Editor */}
        <div className="min-h-[400px]">
          <BlockNoteView
            editor={editor}
            onChange={handleContentChange}
            theme={darkMode ? 'dark' : 'light'}
          />
        </div>
      </div>
    </div>
  );
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
      <InlineField label="Hostname" value={data.hostname ?? ''} onChange={(v) => onChange({ hostname: v })} />
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
  useEffect(() => { if (!cvssFocused) setCvssText(String(data.cvss ?? 0)); }, [data.cvss, cvssFocused]);
  const commitCvss = () => {
    setCvssFocused(false);
    let num = parseFloat(cvssText);
    if (isNaN(num)) num = 0;
    num = Math.max(0, Math.min(10, num));
    setCvssText(String(num));
    onChange({ cvss: num });
  };
  return (
    <>
      <InlineField label="Title" value={data.title ?? ''} onChange={(v) => onChange({ title: v })} />
      <div className="flex items-center gap-3">
        <label className="w-28 shrink-0 text-xs text-[hsl(var(--muted-foreground))]">Severity</label>
        <select
          value={data.severity ?? 'medium'}
          onChange={(e) => onChange({ severity: e.target.value })}
          className="flex-1 border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none focus:border-[hsl(var(--primary))]"
        >
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="info">Info</option>
        </select>
      </div>
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
    </>
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
