import { useCallback, useEffect, useRef, useState, useMemo, memo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type OnConnect,
  type OnNodesChange,
  type OnEdgesChange,
  type Connection,
  type NodeTypes,
  type EdgeTypes,
  type OnNodeDrag,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
  Panel,
  applyNodeChanges,
  applyEdgeChanges,
  getNodesBounds,
  getViewportForBounds,
} from '@xyflow/react';
import { toPng } from 'html-to-image';
import '@xyflow/react/dist/style.css';
import { useAppStore } from '@/stores';
import { HostNode } from './nodes/HostNode';
import { CredentialNode } from './nodes/CredentialNode';
import { ServiceNode } from './nodes/ServiceNode';
import { FindingNode } from './nodes/FindingNode';
import { PivotNode } from './nodes/PivotNode';
import { LabeledEdge } from './edges/LabeledEdge';
import { NodePalette } from './NodePalette';
import { GraphContextMenu } from './GraphContextMenu';
import { autoLayout, DEFAULT_LAYOUT_OPTIONS, type LayoutOptions } from '@/lib/auto-layout';
import { findShortestPath } from '@/lib/pathfinding';
import type { NodeType, EdgeType } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { nmapMachineRepo } from '@/db/nmap-repo';

// ── Per-graph viewport cache (survives tab switches, not full page reloads) ──
const viewportCache = new Map<string, { x: number; y: number; zoom: number }>();

// ── Static objects outside component — never recreated ──

const nodeTypes: NodeTypes = {
  host: HostNode,
  credential: CredentialNode,
  service: ServiceNode,
  finding: FindingNode,
  pivot: PivotNode,
};

const edgeTypes: EdgeTypes = {
  labeled: LabeledEdge,
};

const NODE_LABELS: Record<string, string> = {
  host: 'New Host',
  credential: 'New Credential',
  service: 'New Service',
  finding: 'New Finding',
  pivot: 'New Pivot',
};

const HIGHLIGHT_STYLE = { stroke: '#d4a017', strokeWidth: 3 } as const;
const CHAIN_HIGHLIGHT_STYLE = { stroke: '#ef4444', strokeWidth: 3 } as const;
const DEFAULT_EDGE_STYLE = { stroke: '#737373', strokeWidth: 1.5 } as const;
const ARROW_MARKER = { type: MarkerType.ArrowClosed } as const;

/** Extract searchable text from a node's data */
function getNodeSearchText(node: { type?: string; data: Record<string, unknown> }): string {
  const d = node.data;
  const parts: string[] = [];
  if (d.label) parts.push(String(d.label));
  if (d.hostname) parts.push(String(d.hostname));
  if (d.ip) parts.push(String(d.ip));
  if (d.os) parts.push(String(d.os));
  if (d.name) parts.push(String(d.name));
  if (d.version) parts.push(String(d.version));
  if (d.title) parts.push(String(d.title));
  if (d.username) parts.push(String(d.username));
  if (d.source) parts.push(String(d.source));
  if (d.description) parts.push(String(d.description));
  if (d.severity) parts.push(String(d.severity));
  if (d.port) parts.push(String(d.port));
  if (Array.isArray(d.cves)) parts.push(...(d.cves as string[]));
  if (Array.isArray(d.openPorts)) parts.push(...(d.openPorts as number[]).map(String));
  return parts.join(' ').toLowerCase();
}

/** Simple fuzzy score: consecutive chars matched / total query length, with bonus for prefix matches */
function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  // Exact substring match gets highest score
  const subIdx = t.indexOf(q);
  if (subIdx !== -1) return 1000 - subIdx; // prefer earlier matches
  // Fuzzy: find characters in order
  let qi = 0;
  let consecutive = 0;
  let maxConsecutive = 0;
  let matched = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      matched++;
      consecutive++;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
    } else {
      consecutive = 0;
    }
  }
  if (matched < q.length * 0.5) return 0; // too few chars matched
  return (matched / q.length) * 100 + maxConsecutive * 10;
}

const NODE_TYPE_LABELS: Record<string, string> = {
  host: 'Host',
  credential: 'Credential',
  service: 'Service',
  finding: 'Finding',
  pivot: 'Pivot',
};

// ── Helpers ──

/** Order selected node ids top-to-bottom, left-to-right by their current canvas position. */
function orderChainNodesByPosition(ids: string[], nodes: Node[]): string[] {
  const pos = new Map(nodes.map((n) => [n.id, n.position]));
  return [...ids].sort((a, b) => {
    const pa = pos.get(a);
    const pb = pos.get(b);
    if (!pa || !pb) return 0;
    if (Math.abs(pa.y - pb.y) > 40) return pa.y - pb.y;
    return pa.x - pb.x;
  });
}

function buildNodes(
  graphNodes: ReturnType<typeof useAppStore.getState>['graphNodes'],
  graphId: string,
  highlighted: Set<string>,
  flashId?: string | null,
  chainNodeIds?: Set<string>,
): Node[] {
  return graphNodes
    .filter((n) => n.graphId === graphId)
    .map((n) => {
      const classes: string[] = [];
      if (n.id === flashId) classes.push('node-flash-highlight');
      if (chainNodeIds?.has(n.id)) classes.push('node-chain-highlight');
      return {
        id: n.id,
        type: n.type,
        position: n.position,
        data: { ...n.data, label: n.label, nodeId: n.id, highlighted: highlighted.has(n.id) },
        className: classes.length > 0 ? classes.join(' ') : undefined,
      };
    });
}

function buildEdges(
  graphEdges: ReturnType<typeof useAppStore.getState>['graphEdges'],
  graphId: string,
  highlighted: Set<string>,
  chainMode: boolean,
): Edge[] {
  return graphEdges
    .filter((e) => e.graphId === graphId)
    .map((e) => {
      const isHighlighted = highlighted.has(e.id);
      return {
        id: e.id,
        source: e.sourceNodeId,
        target: e.targetNodeId,
        type: 'labeled',
        data: { label: e.label, edgeType: e.edgeType, highlighted: isHighlighted },
        markerEnd: ARROW_MARKER,
        animated: isHighlighted,
        className: isHighlighted && chainMode ? 'chain-edge' : undefined,
        style: isHighlighted
          ? (chainMode ? CHAIN_HIGHLIGHT_STYLE : HIGHLIGHT_STYLE)
          : DEFAULT_EDGE_STYLE,
      };
    });
}

// ── Component ──

const GraphCanvasInner = memo(function GraphCanvasInner({ graphId }: { graphId: string }) {
  const graphNodes = useAppStore((s) => s.graphNodes);
  const graphEdges = useAppStore((s) => s.graphEdges);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const addGraphNode = useAppStore((s) => s.addGraphNode);
  const updateGraphNode = useAppStore((s) => s.updateGraphNode);
  const deleteGraphNode = useAppStore((s) => s.deleteGraphNode);
  const addGraphEdge = useAppStore((s) => s.addGraphEdge);
  const updateGraphEdge = useAppStore((s) => s.updateGraphEdge);
  const deleteGraphEdge = useAppStore((s) => s.deleteGraphEdge);
  const setSelectedNode = useAppStore((s) => s.setSelectedNode);
  const setSelectedEdge = useAppStore((s) => s.setSelectedEdge);
  const openTab = useAppStore((s) => s.openTab);
  const pendingFocusNodeId = useAppStore((s) => s.pendingFocusNodeId);
  const setPendingFocusNodeId = useAppStore((s) => s.setPendingFocusNodeId);
  const attackChains = useAppStore((s) => s.attackChains);
  const createAttackChain = useAppStore((s) => s.createAttackChain);
  const addNodesToAttackChain = useAppStore((s) => s.addNodesToAttackChain);
  const pendingHighlightChainId = useAppStore((s) => s.pendingHighlightChainId);
  const setPendingHighlightChainId = useAppStore((s) => s.setPendingHighlightChainId);

  const { fitView, screenToFlowPosition, getViewport, setViewport } = useReactFlow();
  const hasRestoredViewport = useRef(false);

  // ── Local state: React Flow owns these during drag, we sync from DB ──
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [highlightedPath, setHighlightedPath] = useState<Set<string>>(new Set());
  const [highlightChainMode, setHighlightChainMode] = useState(false);
  const [highlightedChainNodes, setHighlightedChainNodes] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId?: string; edgeId?: string; nodeType?: string; hasLinkedNmap?: boolean; selectedNodeIds: string[] } | null>(null);
  const [pathStartId, setPathStartId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'node' | 'edge'; items: { id: string; label: string }[] } | null>(null);
  const [pendingNewChain, setPendingNewChain] = useState<{ nodeIds: string[]; name: string } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showNodeSearch, setShowNodeSearch] = useState(false);
  const [nodeSearchQuery, setNodeSearchQuery] = useState('');
  const [searchSelectedIdx, setSearchSelectedIdx] = useState(0);
  const [flashNodeId, setFlashNodeId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultsRef = useRef<HTMLDivElement>(null);

  // ── Undo stack for node moves ──
  const undoStack = useRef<{ nodeId: string; position: { x: number; y: number } }[]>([]);
  const dragStartPositions = useRef<Map<string, { x: number; y: number }>>(new Map());
  // While the local user is dragging nodes, suppress the store→local
  // rebuild effect so a re-render triggered by our own per-frame writes
  // (or by an unrelated store change) doesn't snap the cursor's grip.
  const isDraggingRef = useRef(false);
  // Throttle per-frame position writes so we send at most one update
  // per animation frame per node (~60Hz) — plenty for smooth remote
  // playback without flooding the WebSocket.
  const dragRafScheduled = useRef(false);
  const dragLatestPositions = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Refs for stable callbacks
  const graphNodesRef = useRef(graphNodes);
  graphNodesRef.current = graphNodes;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // Save viewport before unmount or graphId change
  useEffect(() => {
    return () => {
      try {
        const vp = getViewport();
        viewportCache.set(graphId, vp);
      } catch { /* getViewport may throw if ReactFlow not ready */ }
    };
  }, [graphId, getViewport]);

  // Load graph data on mount
  useEffect(() => {
    hasRestoredViewport.current = false;
    void loadGraphData(graphId);
  }, [graphId, loadGraphData]);

  // Sync store → local state (only when DB data changes, NOT during drag)
  const memoNodes = useMemo(
    () => buildNodes(graphNodes, graphId, highlightedPath, flashNodeId, highlightedChainNodes),
    [graphNodes, graphId, highlightedPath, flashNodeId, highlightedChainNodes],
  );
  useEffect(() => {
    // Don't clobber an in-progress local drag with the rebuilt list —
    // React Flow's gesture state lives in our `nodes` state and would
    // jump if we replaced positions mid-gesture.
    if (isDraggingRef.current) return;
    setNodes(memoNodes);
  }, [memoNodes]);

  const memoEdges = useMemo(
    () => buildEdges(graphEdges, graphId, highlightedPath, highlightChainMode),
    [graphEdges, graphId, highlightedPath, highlightChainMode],
  );
  useEffect(() => { setEdges(memoEdges); }, [memoEdges]);

  // ── onNodesChange: apply ALL changes locally (position, select, remove, etc.) ──
  // This is the key perf fix: React Flow updates local state instantly during drag.
  // No store round-trip, no async, no re-derive from DB.
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      const removals = changes.filter((c) => c.type === 'remove');
      const rest = changes.filter((c) => c.type !== 'remove');
      // Apply non-remove changes immediately
      if (rest.length > 0) setNodes((prev) => applyNodeChanges(rest, prev));
      if (removals.length > 0) {
        const items = removals.map((r) => {
          const node = graphNodesRef.current.find((n) => n.id === r.id);
          return { id: r.id, label: node?.label ?? r.id };
        });
        setPendingDelete({ kind: 'node', items });
      }
    },
    []
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      const removals = changes.filter((c) => c.type === 'remove');
      const rest = changes.filter((c) => c.type !== 'remove');
      if (rest.length > 0) setEdges((prev) => applyEdgeChanges(rest, prev));
      if (removals.length > 0) {
        const id = removals[0]!.id;
        setPendingDelete({ kind: 'edge', items: [{ id, label: id }] });
      }
    },
    []
  );

  // Persist position to DB only on drag stop
  const onNodeDragStart: OnNodeDrag = useCallback(
    (_event, node, draggedNodes) => {
      isDraggingRef.current = true;
      dragStartPositions.current.clear();
      const all = draggedNodes.length > 0 ? draggedNodes : [node];
      for (const n of all) {
        dragStartPositions.current.set(n.id, { ...n.position });
      }
    },
    []
  );

  // Stream the current position(s) to the shared doc on every frame so
  // collaborators on other machines see the move live (Google-Docs / Figma
  // style). We coalesce all positions touched during a frame into a single
  // requestAnimationFrame callback to avoid spamming the WebSocket.
  const onNodeDrag: OnNodeDrag = useCallback(
    (_event, node, draggedNodes) => {
      const all = draggedNodes.length > 0 ? draggedNodes : [node];
      for (const n of all) {
        dragLatestPositions.current.set(n.id, { x: n.position.x, y: n.position.y });
      }
      if (dragRafScheduled.current) return;
      dragRafScheduled.current = true;
      requestAnimationFrame(() => {
        dragRafScheduled.current = false;
        const batch = dragLatestPositions.current;
        if (batch.size === 0) return;
        for (const [id, pos] of batch) {
          void updateGraphNode(id, { position: pos });
        }
        batch.clear();
      });
    },
    [updateGraphNode]
  );

  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, node, draggedNodes) => {
      const all = draggedNodes.length > 0 ? draggedNodes : [node];
      for (const n of all) {
        const prev = dragStartPositions.current.get(n.id);
        if (prev) {
          undoStack.current.push({ nodeId: n.id, position: prev });
        }
        void updateGraphNode(n.id, { position: n.position });
      }
      dragStartPositions.current.clear();
      dragLatestPositions.current.clear();
      dragRafScheduled.current = false;
      isDraggingRef.current = false;
    },
    [updateGraphNode]
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        void addGraphEdge(graphId, connection.source, connection.target, 'Custom');
      }
    },
    [graphId, addGraphEdge]
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNode(node.id);
      setSelectedEdge(null);
    },
    [setSelectedNode, setSelectedEdge]
  );

  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const dbNode = graphNodesRef.current.find((n) => n.id === node.id);
      if (dbNode) {
        openTab({ id: uuidv4(), kind: 'page', entityId: dbNode.linkedPageId, title: dbNode.label });
      }
    },
    [openTab]
  );

  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      setSelectedEdge(edge.id);
      setSelectedNode(null);
    },
    [setSelectedEdge, setSelectedNode]
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
    setContextMenu(null);
  }, [setSelectedNode, setSelectedEdge]);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    const gNode = graphNodesRef.current.find((n) => n.id === node.id);
    const nodeType = gNode?.type;
    const selectedIds = nodesRef.current.filter((n) => n.selected).map((n) => n.id);
    // If right-click target isn't in selection, treat it as a single-node context
    const effectiveIds = selectedIds.includes(node.id) ? selectedIds : [node.id];
    if (nodeType === 'host') {
      void nmapMachineRepo.getByLinkedNode(node.id).then((m) => {
        setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id, nodeType, hasLinkedNmap: !!m, selectedNodeIds: effectiveIds });
      });
    } else {
      setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id, nodeType, selectedNodeIds: effectiveIds });
    }
  }, []);

  const onEdgeContextMenu = useCallback((event: React.MouseEvent, edge: Edge) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, edgeId: edge.id, selectedNodeIds: [] });
  }, []);

  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    const selectedIds = nodesRef.current.filter((n) => n.selected).map((n) => n.id);
    setContextMenu({ x: event.clientX, y: event.clientY, selectedNodeIds: selectedIds });
  }, []);

  const handleDropNode = useCallback(
    (type: NodeType, clientPosition: { x: number; y: number }) => {
      const position = screenToFlowPosition(clientPosition);
      void addGraphNode(graphId, type, NODE_LABELS[type] ?? type, position);
    },
    [graphId, addGraphNode, screenToFlowPosition]
  );

  const [layoutOptions, setLayoutOptions] = useState<LayoutOptions>({ ...DEFAULT_LAYOUT_OPTIONS });
  const [showLayoutConfig, setShowLayoutConfig] = useState(false);

  const handleAutoLayout = useCallback(() => {
    const layouted = autoLayout(nodesRef.current, edgesRef.current, 'TB', layoutOptions);
    for (const node of layouted) {
      void updateGraphNode(node.id, { position: node.position });
    }
    setTimeout(() => fitView({ padding: 0.2 }), 50);
  }, [updateGraphNode, fitView, layoutOptions]);

  const handleHighlightPath = useCallback(() => {
    const cur = nodesRef.current;
    const curE = edgesRef.current;
    const sel = cur.filter((n) => n.selected);
    if (sel.length === 2 && sel[0] && sel[1]) {
      const ids = findShortestPath(
        cur.map((n) => n.id),
        curE.map((e) => ({ id: e.id, source: e.source, target: e.target })),
        sel[0].id,
        sel[1].id,
      );
      setHighlightChainMode(false);
      setHighlightedChainNodes(new Set());
      setHighlightedPath(new Set(ids));
    } else if (pathStartId) {
      const end = cur.find((n) => n.selected);
      if (end) {
        const ids = findShortestPath(
          cur.map((n) => n.id),
          curE.map((e) => ({ id: e.id, source: e.source, target: e.target })),
          pathStartId,
          end.id,
        );
        setHighlightChainMode(false);
        setHighlightedChainNodes(new Set());
        setHighlightedPath(new Set(ids));
        setPathStartId(null);
      }
    }
  }, [pathStartId]);

  const handleClearHighlight = useCallback(() => {
    setHighlightedPath(new Set());
    setHighlightChainMode(false);
    setHighlightedChainNodes(new Set());
    setPathStartId(null);
  }, []);

  /** Compute the union of shortest-path edges through an ordered chain of node ids. */
  const computeChainEdges = useCallback((nodeIds: string[]): Set<string> => {
    const cur = nodesRef.current;
    const curE = edgesRef.current;
    const nodeIdsAll = cur.map((n) => n.id);
    const edgeList = curE.map((e) => ({ id: e.id, source: e.source, target: e.target }));
    const result = new Set<string>();
    for (let i = 0; i < nodeIds.length - 1; i++) {
      const a = nodeIds[i];
      const b = nodeIds[i + 1];
      if (!a || !b) continue;
      const segment = findShortestPath(nodeIdsAll, edgeList, a, b);
      segment.forEach((id) => result.add(id));
    }
    return result;
  }, []);

  const handleExportPng = useCallback(() => {
    setIsExporting(true);
  }, []);

  // ── Ctrl+Z undo for node moves ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        const entry = undoStack.current.pop();
        if (entry) {
          e.preventDefault();
          void updateGraphNode(entry.nodeId, { position: entry.position });
          setNodes((prev) =>
            prev.map((n) =>
              n.id === entry.nodeId ? { ...n, position: entry.position } : n
            )
          );
        }
      }
      // Ctrl+F: open node search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowNodeSearch(true);
        setNodeSearchQuery('');
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [updateGraphNode]);

  // ── Node search results ──
  const searchResults = useMemo(() => {
    if (!nodeSearchQuery.trim()) return [];
    const q = nodeSearchQuery.trim();
    return nodesRef.current
      .map((node) => {
        const text = getNodeSearchText(node as { type?: string; data: Record<string, unknown> });
        const score = fuzzyScore(q, text);
        return { node, score, text };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  }, [nodeSearchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const navigateToNode = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node) return;
    // Zoom to node
    fitView({ nodes: [node], padding: 1.5, duration: 400 });
    // Flash highlight
    setFlashNodeId(nodeId);
    setTimeout(() => setFlashNodeId(null), 1200);
    setShowNodeSearch(false);
  }, [fitView]);

  // Consume pendingFocusNodeId from store (e.g. "Go to Node" from Nmap)
  useEffect(() => {
    if (!pendingFocusNodeId) return;
    // Wait for nodes to be loaded
    const target = nodesRef.current.find((n) => n.id === pendingFocusNodeId);
    if (target) {
      setPendingFocusNodeId(null);
      // Small delay to let React Flow settle
      setTimeout(() => navigateToNode(pendingFocusNodeId), 200);
    }
  }, [pendingFocusNodeId, nodes, setPendingFocusNodeId, navigateToNode]);

  // Consume pendingHighlightChainId from store (Attack Chain sidebar click)
  useEffect(() => {
    if (!pendingHighlightChainId) return;
    const chain = attackChains.find((c) => c.id === pendingHighlightChainId);
    if (!chain || chain.graphId !== graphId) return;
    // Make sure all chain nodes are rendered before highlighting
    const allRendered = chain.nodeIds.every((nid) => nodesRef.current.some((n) => n.id === nid));
    if (!allRendered && nodesRef.current.length === 0) return;
    setPendingHighlightChainId(null);
    setTimeout(() => {
      const edgeSet = computeChainEdges(chain.nodeIds);
      setHighlightChainMode(true);
      setHighlightedChainNodes(new Set(chain.nodeIds));
      setHighlightedPath(edgeSet);
      // Also fit view to the chain nodes
      const chainNodes = nodesRef.current.filter((n) => chain.nodeIds.includes(n.id));
      if (chainNodes.length > 0) {
        fitView({ nodes: chainNodes, padding: 0.3, duration: 400 });
      }
    }, 200);
  }, [pendingHighlightChainId, attackChains, graphId, nodes, setPendingHighlightChainId, computeChainEdges, fitView]);

  // Run actual PNG capture after virtualization is disabled and React Flow renders all elements
  useEffect(() => {
    if (!isExporting) return;
    const timer = setTimeout(() => {
      const flowEl = document.querySelector('.react-flow') as HTMLElement;
      if (!flowEl) { setIsExporting(false); return; }
      const viewport = flowEl.querySelector('.react-flow__viewport') as HTMLElement;
      if (!viewport) { setIsExporting(false); return; }
      const currentNodes = nodesRef.current;
      if (currentNodes.length === 0) { setIsExporting(false); return; }

      const bounds = getNodesBounds(currentNodes);
      const padding = 60;
      const scale = .5;   // Makes nodes/edges 8x bigger in the image
      const imageWidth = (bounds.width + padding * 2) * scale;
      const imageHeight = (bounds.height + padding * 2) * scale;
      const transform = getViewportForBounds(bounds, imageWidth, imageHeight, 0.5, 10, padding * scale);

      // Resolve CSS custom properties so they survive the html-to-image clone
      const computed = getComputedStyle(document.documentElement);
      const cssVarNames = [
        '--background', '--foreground', '--card', '--card-foreground',
        '--border', '--input', '--primary', '--muted-foreground',
        '--accent', '--accent-foreground', '--destructive',
        '--destructive-foreground', '--secondary', '--secondary-foreground',
        '--status-green', '--status-amber', '--status-red',
      ];
      cssVarNames.forEach((v) => viewport.style.setProperty(v, computed.getPropertyValue(v)));

      // Inline resolved stroke on SVG edge paths so they survive the DOM clone
      const edgePaths = viewport.querySelectorAll<SVGPathElement>('.react-flow__edge-path');
      const originalStrokes: { el: SVGPathElement; stroke: string; strokeWidth: string }[] = [];
      edgePaths.forEach((p) => {
        const cs = getComputedStyle(p);
        originalStrokes.push({ el: p, stroke: p.style.stroke, strokeWidth: p.style.strokeWidth });
        if (!p.style.stroke) p.style.stroke = cs.stroke;
        if (!p.style.strokeWidth) p.style.strokeWidth = cs.strokeWidth;
      });

      // Clone SVG marker defs (arrowheads) into viewport so marker-end references work
      const markerSvg = flowEl.querySelector('svg.react-flow__marker') ?? flowEl.querySelector('svg[class*="marker"]');
      let clonedMarkerSvg: SVGElement | null = null;
      if (markerSvg) {
        clonedMarkerSvg = markerSvg.cloneNode(true) as SVGElement;
        clonedMarkerSvg.style.position = 'absolute';
        clonedMarkerSvg.style.width = '0';
        clonedMarkerSvg.style.height = '0';
        viewport.appendChild(clonedMarkerSvg);
      }

      toPng(viewport, {
        backgroundColor: '#09090b',
        width: imageWidth,
        height: imageHeight,
        // edits the pixel quality of the exported image
        pixelRatio: 4,
        style: {
          width: `${imageWidth}px`,
          height: `${imageHeight}px`,
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`,
        },
      }).then((dataUrl) => {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `attack-narrative-${graphId}.png`;
        a.click();
      }).finally(() => {
        // Clean up: remove injected CSS vars, restore edge strokes, remove cloned marker defs
        cssVarNames.forEach((v) => viewport.style.removeProperty(v));
        originalStrokes.forEach(({ el, stroke, strokeWidth }) => {
          el.style.stroke = stroke;
          el.style.strokeWidth = strokeWidth;
        });
        if (clonedMarkerSvg) viewport.removeChild(clonedMarkerSvg);
        setIsExporting(false);
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [isExporting, graphId]);

  const handleContextAction = useCallback(
    (action: string) => {
      if (!contextMenu) return;
      // Attack-chain actions
      if (action === 'chain:new') {
        const ids = contextMenu.selectedNodeIds;
        if (ids.length >= 2) {
          const ordered = orderChainNodesByPosition(ids, nodesRef.current);
          setPendingNewChain({ nodeIds: ordered, name: `Chain ${attackChains.filter(c => c.graphId === graphId).length + 1}` });
        }
        setContextMenu(null);
        return;
      }
      if (action.startsWith('chain:add:')) {
        const chainId = action.slice('chain:add:'.length);
        const ids = orderChainNodesByPosition(contextMenu.selectedNodeIds, nodesRef.current);
        void addNodesToAttackChain(chainId, ids).then(() => {
          setPendingHighlightChainId(chainId);
        });
        setContextMenu(null);
        return;
      }
      switch (action) {
        case 'delete-node':
          if (contextMenu.nodeId) {
            const node = graphNodesRef.current.find((n) => n.id === contextMenu.nodeId);
            setPendingDelete({ kind: 'node', items: [{ id: contextMenu.nodeId, label: node?.label ?? contextMenu.nodeId }] });
          }
          break;
        case 'delete-edge':
          if (contextMenu.edgeId) {
            setPendingDelete({ kind: 'edge', items: [{ id: contextMenu.edgeId, label: contextMenu.edgeId }] });
          }
          break;
        case 'open-page':
          if (contextMenu.nodeId) {
            const node = graphNodesRef.current.find((n) => n.id === contextMenu.nodeId);
            if (node) openTab({ id: uuidv4(), kind: 'page', entityId: node.linkedPageId, title: node.label });
          }
          break;
        case 'set-path-start':
          if (contextMenu.nodeId) setPathStartId(contextMenu.nodeId);
          break;
        case 'go-to-nmap':
          if (contextMenu.nodeId) {
            void nmapMachineRepo.getByLinkedNode(contextMenu.nodeId).then((machine) => {
              if (machine) {
                openTab({ id: uuidv4(), kind: 'nmap-machine', entityId: machine.id, title: machine.hostname || machine.ip });
              }
            });
          }
          break;
        case 'set-path-end':
          if (contextMenu.nodeId && pathStartId) {
            const cur = nodesRef.current;
            const curE = edgesRef.current;
            const ids = findShortestPath(
              cur.map((n) => n.id),
              curE.map((e) => ({ id: e.id, source: e.source, target: e.target })),
              pathStartId,
              contextMenu.nodeId,
            );
            setHighlightedPath(new Set(ids));
            setPathStartId(null);
          }
          break;
        case 'add-host':
        case 'add-credential':
        case 'add-service':
        case 'add-finding':
        case 'add-pivot': {
          const type = action.replace('add-', '') as NodeType;
          const position = screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y });
          void addGraphNode(graphId, type, NODE_LABELS[type] ?? type, position);
          break;
        }
      }
      setContextMenu(null);
    },
    [contextMenu, openTab, addGraphNode, graphId, screenToFlowPosition, pathStartId, attackChains, addNodesToAttackChain, setPendingHighlightChainId],
  );

  const confirmDelete = useCallback(() => {
    if (!pendingDelete) return;
    for (const item of pendingDelete.items) {
      if (pendingDelete.kind === 'node') void deleteGraphNode(item.id);
      else void deleteGraphEdge(item.id);
    }
    setPendingDelete(null);
  }, [pendingDelete, deleteGraphNode, deleteGraphEdge]);

  const handleSetEdgeType = useCallback(
    (edgeId: string, edgeType: EdgeType) => {
      void updateGraphEdge(edgeId, { edgeType, label: edgeType });
      setContextMenu(null);
    },
    [updateGraphEdge],
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // ── Cat background toggle (persisted across reloads) ──
  const [catBgEnabled, setCatBgEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('graphCatBg') !== '0';
  });
  useEffect(() => {
    window.localStorage.setItem('graphCatBg', catBgEnabled ? '1' : '0');
  }, [catBgEnabled]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[hsl(var(--background))]">
      {/* Looping video background */}
      {catBgEnabled && (
        <>
          <video
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            src="/alexcatwalk.mp4"
            autoPlay
            loop
            muted
            playsInline
          />
          {/* Dim overlay so the video doesn't overpower node readability */}
          <div className="pointer-events-none absolute inset-0 bg-[hsl(var(--background))]/60" />
        </>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onlyRenderVisibleElements={!isExporting}
        fitView={!viewportCache.has(graphId)}
        onInit={() => {
          const cached = viewportCache.get(graphId);
          if (cached && !hasRestoredViewport.current) {
            hasRestoredViewport.current = true;
            setViewport(cached, { duration: 0 });
          }
        }}
        className="!bg-transparent"
      >
        <Background color="hsl(0 0% 14%)" gap={20} size={1.5} bgColor="transparent" />
        <Controls className="!bg-[hsl(var(--card))] !border-[hsl(var(--border))] !shadow-none [&>button]:!bg-[hsl(var(--card))] [&>button]:!border-[hsl(var(--border))] [&>button]:!fill-[hsl(var(--foreground))]" />
        <Panel position="top-right">
          <button
            type="button"
            onClick={() => setCatBgEnabled((v) => !v)}
            title={catBgEnabled ? 'Disable cat background' : 'Enable cat background'}
            className="border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-1 text-[10px] uppercase tracking-wider hover:bg-[hsl(var(--accent))]"
          >
            {catBgEnabled ? 'Cat: On' : 'Cat: Off'}
          </button>
        </Panel>
        <Panel position="top-center">
          <NodePalette onDrop={handleDropNode} />
        </Panel>
        <Panel position="bottom-center">
          <div className="flex flex-wrap items-center justify-center gap-1">
            <div className="relative flex">
              <button onClick={handleAutoLayout} className="border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-1 text-[10px] uppercase tracking-wider hover:bg-[hsl(var(--accent))]">
                Auto Layout
              </button>
              <button
                onClick={() => setShowLayoutConfig((v) => !v)}
                className="-ml-px border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-1.5 py-1 text-[10px] hover:bg-[hsl(var(--accent))]"
                title="Layout settings"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
              {showLayoutConfig && (
                <div className="absolute bottom-full right-0 mb-1 z-50 w-56 border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3 shadow-xl">
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Layout Settings</div>
                  {([
                    { key: 'nodesep' as const, label: 'Node Spacing', min: 20, max: 300 },
                    { key: 'ranksep' as const, label: 'Rank Spacing', min: 20, max: 300 },
                    { key: 'edgesep' as const, label: 'Edge Spacing', min: 5, max: 100 },
                  ] as const).map(({ key, label, min, max }) => (
                    <div key={key} className="mb-2">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] text-[hsl(var(--muted-foreground))]">{label}</label>
                        <span className="text-[10px] font-mono text-[hsl(var(--foreground))]">{layoutOptions[key]}</span>
                      </div>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        value={layoutOptions[key]}
                        onChange={(e) => setLayoutOptions((o) => ({ ...o, [key]: Number(e.target.value) }))}
                        className="mt-1 w-full accent-[hsl(var(--foreground))] h-1"
                      />
                    </div>
                  ))}
                  <button
                    onClick={() => { handleAutoLayout(); setShowLayoutConfig(false); }}
                    className="mt-1 w-full border border-[hsl(var(--border))] bg-[hsl(var(--accent))] px-2 py-1 text-[10px] uppercase tracking-wider hover:bg-[hsl(var(--foreground))] hover:text-[hsl(var(--background))]"
                  >
                    Apply Layout
                  </button>
                </div>
              )}
            </div>
            <button onClick={handleHighlightPath} className="border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-1 text-[10px] uppercase tracking-wider hover:bg-[hsl(var(--accent))]">
              Highlight Path
            </button>
            <button onClick={handleClearHighlight} className="border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-1 text-[10px] uppercase tracking-wider hover:bg-[hsl(var(--accent))]">
              Clear
            </button>
            <button onClick={handleExportPng} className="border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-1 text-[10px] uppercase tracking-wider hover:bg-[hsl(var(--accent))]">
              Export PNG
            </button>
          </div>
        </Panel>
      </ReactFlow>
      {contextMenu && (
        <GraphContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodeId={contextMenu.nodeId}
          edgeId={contextMenu.edgeId}
          nodeType={contextMenu.nodeType}
          hasLinkedNmap={contextMenu.hasLinkedNmap}
          pathStartId={pathStartId}
          selectedNodeIds={contextMenu.selectedNodeIds}
          chainsInGraph={attackChains.filter((c) => c.graphId === graphId)}
          onAction={handleContextAction}
          onSetEdgeType={handleSetEdgeType}
          onClose={closeContextMenu}
        />
      )}
      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPendingDelete(null)}>
          <div className="w-full max-w-sm border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-sm font-bold">
              Delete {pendingDelete.items.length > 1 ? `${pendingDelete.items.length} Nodes` : pendingDelete.kind === 'node' ? 'Node' : 'Edge'}
            </h3>
            {pendingDelete.items.length === 1 ? (
              <p className="mb-4 text-xs text-[hsl(var(--muted-foreground))]">
                Are you sure you want to delete {pendingDelete.kind === 'node' ? 'node' : 'edge'}{' '}
                <span className="font-semibold text-[hsl(var(--foreground))]">{pendingDelete.items[0]!.label}</span>? This action cannot be undone.
              </p>
            ) : (
              <div className="mb-4">
                <p className="mb-2 text-xs text-[hsl(var(--muted-foreground))]">Are you sure you want to delete the following nodes? This action cannot be undone.</p>
                <ul className="max-h-40 overflow-y-auto space-y-0.5">
                  {pendingDelete.items.map((item) => (
                    <li key={item.id} className="text-xs text-[hsl(var(--foreground))] flex items-center gap-1.5 px-2 py-0.5 bg-[hsl(var(--accent))]">
                      <span className="h-1.5 w-1.5 rounded-full bg-red-400 shrink-0" />
                      {item.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingDelete(null)}
                className="border border-[hsl(var(--border))] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider hover:bg-[hsl(var(--accent))]"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="border border-red-500 bg-red-500/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-red-400 hover:bg-red-500/20"
              >
                Delete{pendingDelete.items.length > 1 ? ` (${pendingDelete.items.length})` : ''}
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingNewChain && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPendingNewChain(null)}>
          <div className="w-full max-w-sm border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-sm font-bold">New Attack Chain</h3>
            <p className="mb-3 text-xs text-[hsl(var(--muted-foreground))]">
              Creating a chain with <span className="text-[hsl(var(--foreground))] font-semibold">{pendingNewChain.nodeIds.length}</span> nodes.
            </p>
            <input
              autoFocus
              value={pendingNewChain.name}
              onChange={(e) => setPendingNewChain((p) => p ? { ...p, name: e.target.value } : null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pendingNewChain.name.trim()) {
                  const { nodeIds, name } = pendingNewChain;
                  void createAttackChain(graphId, name.trim(), nodeIds).then((chain) => {
                    setPendingHighlightChainId(chain.id);
                  });
                  setPendingNewChain(null);
                }
                if (e.key === 'Escape') setPendingNewChain(null);
              }}
              placeholder="Chain name"
              className="w-full border border-[hsl(var(--border))] bg-[hsl(var(--input))] px-2 py-1.5 text-sm outline-none focus:border-[hsl(var(--foreground))]"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setPendingNewChain(null)}
                className="border border-[hsl(var(--border))] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider hover:bg-[hsl(var(--accent))]"
              >
                Cancel
              </button>
              <button
                disabled={!pendingNewChain.name.trim()}
                onClick={() => {
                  const { nodeIds, name } = pendingNewChain;
                  void createAttackChain(graphId, name.trim(), nodeIds).then((chain) => {
                    setPendingHighlightChainId(chain.id);
                  });
                  setPendingNewChain(null);
                }}
                className="border border-[hsl(var(--border))] bg-[hsl(var(--accent))] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider hover:bg-[hsl(var(--foreground))] hover:text-[hsl(var(--background))] disabled:opacity-40"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
      {showNodeSearch && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-24" onClick={() => setShowNodeSearch(false)}>
          <div className="w-96 border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-[hsl(var(--border))] px-3 py-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[hsl(var(--muted-foreground))]"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input
                ref={searchInputRef}
                value={nodeSearchQuery}
                onChange={(e) => { setNodeSearchQuery(e.target.value); setSearchSelectedIdx(0); }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setShowNodeSearch(false);
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSearchSelectedIdx((i) => Math.min(i + 1, searchResults.length - 1));
                    const el = searchResultsRef.current?.children[Math.min(searchSelectedIdx + 1, searchResults.length - 1)] as HTMLElement | undefined;
                    el?.scrollIntoView({ block: 'nearest' });
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSearchSelectedIdx((i) => Math.max(i - 1, 0));
                    const el = searchResultsRef.current?.children[Math.max(searchSelectedIdx - 1, 0)] as HTMLElement | undefined;
                    el?.scrollIntoView({ block: 'nearest' });
                  }
                  if (e.key === 'Enter' && searchResults.length > 0) navigateToNode(searchResults[searchSelectedIdx]!.node.id);
                }}
                placeholder="Search nodes by hostname, IP, service, finding..."
                className="flex-1 bg-transparent text-sm text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))]"
              />
              <kbd className="text-[9px] text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))] px-1 py-0.5 rounded">ESC</kbd>
            </div>
            {nodeSearchQuery.trim() && (
              <div ref={searchResultsRef} className="max-h-72 overflow-y-auto">
                {searchResults.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-[hsl(var(--muted-foreground))]">No matching nodes found</div>
                ) : (
                  searchResults.map((r, idx) => {
                    const d = r.node.data as Record<string, unknown>;
                    const primary = (d.label as string) || (d.hostname as string) || (d.title as string) || (d.name as string) || r.node.id;
                    const secondary = [d.ip, d.hostname !== primary ? d.hostname : null, d.port, d.severity, d.username].filter(Boolean).join(' · ');
                    return (
                      <button
                        key={r.node.id}
                        onClick={() => navigateToNode(r.node.id)}
                        className={`flex w-full items-center gap-3 px-3 py-2 text-left border-b border-[hsl(var(--border))] last:border-b-0 ${idx === searchSelectedIdx ? 'bg-[hsl(var(--accent))]' : 'hover:bg-[hsl(var(--accent))]'}`}
                      >
                        <span className="text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--muted-foreground))] w-16 shrink-0">{NODE_TYPE_LABELS[r.node.type ?? ''] ?? r.node.type}</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs text-[hsl(var(--foreground))]">{primary}</div>
                          {secondary && <div className="truncate text-[10px] text-[hsl(var(--muted-foreground))]">{secondary}</div>}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export function GraphCanvas({ graphId }: { graphId: string }) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner graphId={graphId} />
    </ReactFlowProvider>
  );
}
