import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  ReactFlowProvider,
  MarkerType,
  applyNodeChanges,
  useReactFlow,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type OnNodesChange,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAppStore } from '@/stores';
import { LabeledEdge } from '@/components/graph/edges/LabeledEdge';
import { SiteNode } from './nodes/SiteNode';
import { shortLabel } from './site-visuals';
import type { SiteMapNode, SiteMapEdge } from '@/types';

const nodeTypes: NodeTypes = {
  root: SiteNode, subdomain: SiteNode, page: SiteNode, endpoint: SiteNode,
  api: SiteNode, js: SiteNode, form: SiteNode, external: SiteNode,
};
const edgeTypes: EdgeTypes = { labeled: LabeledEdge };
const ARROW_MARKER = { type: MarkerType.ArrowClosed } as const;
const DEFAULT_EDGE_STYLE = { stroke: '#737373', strokeWidth: 1.5 } as const;

function buildNodes(records: SiteMapNode[], siteMapId: string, flashId: string | null): Node[] {
  return records
    .filter((n) => n.siteMapId === siteMapId)
    .map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: {
        type: n.type,
        label: n.title || shortLabel(n.url),
        method: n.method,
        status: n.status,
        contentType: n.contentType,
        highlighted: n.id === flashId,
        nodeId: n.id,
      },
      className: n.id === flashId ? 'node-flash-highlight' : undefined,
    }));
}

function buildEdges(records: SiteMapEdge[], siteMapId: string): Edge[] {
  return records
    .filter((e) => e.siteMapId === siteMapId)
    .map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      type: 'labeled',
      data: { label: e.label, edgeType: e.kind, highlighted: false },
      markerEnd: ARROW_MARKER,
      style: DEFAULT_EDGE_STYLE,
    }));
}

const SiteMapCanvasInner = memo(function SiteMapCanvasInner({ siteMapId }: { siteMapId: string }) {
  const siteMapNodes = useAppStore((s) => s.siteMapNodes);
  const siteMapEdges = useAppStore((s) => s.siteMapEdges);
  const loadSiteMapData = useAppStore((s) => s.loadSiteMapData);
  const updateSiteMapNodePositions = useAppStore((s) => s.updateSiteMapNodePositions);
  const autoLayoutSiteMap = useAppStore((s) => s.autoLayoutSiteMap);
  const pendingFocusNodeId = useAppStore((s) => s.pendingFocusNodeId);
  const setPendingFocusNodeId = useAppStore((s) => s.setPendingFocusNodeId);

  const { fitView } = useReactFlow();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [flashId, setFlashId] = useState<string | null>(null);
  const skipNextSync = useRef(false);
  const dragStart = useRef<Map<string, { x: number; y: number }>>(new Map());
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useEffect(() => { void loadSiteMapData(siteMapId); }, [siteMapId, loadSiteMapData]);

  const memoNodes = useMemo(() => buildNodes(siteMapNodes, siteMapId, flashId), [siteMapNodes, siteMapId, flashId]);
  useEffect(() => {
    if (skipNextSync.current) { skipNextSync.current = false; return; }
    setNodes(memoNodes);
  }, [memoNodes]);

  const memoEdges = useMemo(() => buildEdges(siteMapEdges, siteMapId), [siteMapEdges, siteMapId]);
  useEffect(() => { setEdges(memoEdges); }, [memoEdges]);

  const onNodesChange: OnNodesChange = useCallback((changes) => {
    // Positions/selection only: nodes aren't deletable from the canvas (that
    // lives in the list panel, behind a confirm). Drop remove changes.
    const rest = changes.filter((c) => c.type !== 'remove');
    if (rest.length > 0) setNodes((prev) => applyNodeChanges(rest, prev));
  }, []);

  const onNodeDragStart: OnNodeDrag = useCallback((_e, node, dragged) => {
    dragStart.current.clear();
    for (const n of (dragged.length ? dragged : [node])) dragStart.current.set(n.id, { ...n.position });
  }, []);

  const onNodeDragStop: OnNodeDrag = useCallback((_e, node, dragged) => {
    const all = dragged.length ? dragged : [node];
    let moved = false;
    for (const n of all) {
      const prev = dragStart.current.get(n.id);
      if (prev && (prev.x !== n.position.x || prev.y !== n.position.y)) moved = true;
    }
    void updateSiteMapNodePositions(all.map((n) => ({ id: n.id, position: n.position })));
    if (moved) skipNextSync.current = true;
    dragStart.current.clear();
  }, [updateSiteMapNodePositions]);

  const handleAutoLayout = useCallback(() => {
    void autoLayoutSiteMap(siteMapId).then(() => setTimeout(() => fitView({ padding: 0.2 }), 60));
  }, [autoLayoutSiteMap, siteMapId, fitView]);

  // List-row click focuses a node here (shared pendingFocusNodeId, same as nmap).
  useEffect(() => {
    if (!pendingFocusNodeId) return;
    const target = nodesRef.current.find((n) => n.id === pendingFocusNodeId);
    if (!target) return;
    setPendingFocusNodeId(null);
    setTimeout(() => {
      fitView({ nodes: [target], padding: 1.5, duration: 400 });
      setFlashId(pendingFocusNodeId);
      setTimeout(() => setFlashId(null), 1200);
    }, 120);
  }, [pendingFocusNodeId, nodes, setPendingFocusNodeId, fitView]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[hsl(var(--background))]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        deleteKeyCode={null}
        fitView
        minZoom={0.05}
        className="!bg-transparent"
      >
        <Background color="hsl(0 0% 14%)" gap={20} size={1.5} bgColor="transparent" />
        <Controls className="!bg-[hsl(var(--card))] !border-[hsl(var(--border))] !shadow-none [&>button]:!bg-[hsl(var(--card))] [&>button]:!border-[hsl(var(--border))] [&>button]:!fill-[hsl(var(--foreground))]" />
        <Panel position="bottom-center">
          <div className="flex items-center gap-2">
            <button onClick={handleAutoLayout} className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-1.5 text-[10px] uppercase tracking-wider shadow-md hover:bg-[hsl(var(--accent))]">
              Auto Layout
            </button>
            <button onClick={() => fitView({ padding: 0.2, duration: 400 })} className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-1.5 text-[10px] uppercase tracking-wider shadow-md hover:bg-[hsl(var(--accent))]">
              Fit
            </button>
          </div>
        </Panel>
        {nodes.length === 0 && (
          <Panel position="top-center">
            <div className="mt-8 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-3 text-center text-xs text-[hsl(var(--muted-foreground))] shadow-md">
              No recon data yet. Import a scan or run one from the toolbar above.
            </div>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
});

export function SiteMapCanvas({ siteMapId }: { siteMapId: string }) {
  return (
    <ReactFlowProvider>
      <SiteMapCanvasInner siteMapId={siteMapId} />
    </ReactFlowProvider>
  );
}
