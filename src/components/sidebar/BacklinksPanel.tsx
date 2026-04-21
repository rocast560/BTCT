import { useEffect, useState } from 'react';
import { pageRepo } from '@/db';
import type { GraphNode, GraphEdge } from '@/types';
import { Link } from 'lucide-react';

export function BacklinksPanel({ pageId }: { pageId: string }) {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);

  useEffect(() => {
    void pageRepo.getBacklinks(pageId).then(({ nodes, edges }) => {
      setNodes(nodes);
      setEdges(edges);
    });
  }, [pageId]);

  if (nodes.length === 0 && edges.length === 0) {
    return <p className="text-sm text-[hsl(var(--muted-foreground))]">No backlinks found.</p>;
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase text-[hsl(var(--muted-foreground))]">Backlinks</h3>
      {nodes.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs text-[hsl(var(--muted-foreground))]">Nodes</h4>
          {nodes.map((n) => (
            <div key={n.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-[hsl(var(--accent))]">
              <Link size={12} />
              <span>{n.label}</span>
              <span className="text-xs text-[hsl(var(--muted-foreground))]">({n.type})</span>
            </div>
          ))}
        </div>
      )}
      {edges.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs text-[hsl(var(--muted-foreground))]">Edges</h4>
          {edges.map((e) => (
            <div key={e.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-[hsl(var(--accent))]">
              <Link size={12} />
              <span>{e.label}</span>
              <span className="text-xs text-[hsl(var(--muted-foreground))]">({e.edgeType})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
