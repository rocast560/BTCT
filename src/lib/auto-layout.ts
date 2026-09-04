import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';

/* Estimated rendered dimensions per node type */
const NODE_SIZES: Record<string, { width: number; height: number }> = {
  host:       { width: 200, height: 100 },
  service:    { width: 190, height: 95 },
  finding:    { width: 200, height: 90 },
  credential: { width: 190, height: 80 },
  pivot:      { width: 160, height: 70 },
  // Web recon site-map node types (share the same dagre layout).
  root:       { width: 220, height: 74 },
  subdomain:  { width: 210, height: 68 },
  page:       { width: 220, height: 74 },
  endpoint:   { width: 230, height: 74 },
  api:        { width: 230, height: 74 },
  js:         { width: 210, height: 68 },
  form:       { width: 210, height: 74 },
  external:   { width: 210, height: 68 },
};
const DEFAULT_SIZE = { width: 200, height: 100 };

export interface LayoutOptions {
  nodesep: number;
  ranksep: number;
  edgesep: number;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  nodesep: 100,
  ranksep: 100,
  edgesep: 40,
};

export function autoLayout(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB',
  options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: options.nodesep,
    ranksep: options.ranksep,
    edgesep: options.edgesep,
    marginx: 40,
    marginy: 40,
  });

  for (const node of nodes) {
    const sz = NODE_SIZES[node.type ?? ''] ?? DEFAULT_SIZE;
    // Add padding around each node so nothing touches
    g.setNode(node.id, { width: sz.width + 40, height: sz.height + 30 });
  }

  for (const edge of edges) {
    // Give labeled edges extra min-length so their labels don't crowd
    const hasLabel = !!(edge.data as { label?: string } | undefined)?.label;
    g.setEdge(edge.source, edge.target, { minlen: hasLabel ? 2 : 1 });
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    const sz = NODE_SIZES[node.type ?? ''] ?? DEFAULT_SIZE;
    return {
      ...node,
      position: {
        x: (pos?.x ?? 0) - sz.width / 2,
        y: (pos?.y ?? 0) - sz.height / 2,
      },
    };
  });
}
