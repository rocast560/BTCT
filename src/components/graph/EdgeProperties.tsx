import { memo } from 'react';
import { useAppStore } from '@/stores';
import { useShallow } from 'zustand/shallow';
import { EDGE_TYPES, type EdgeType } from '@/types';

export const EdgeProperties = memo(function EdgeProperties({ edgeId }: { edgeId: string }) {
  const edge = useAppStore(useShallow((s) => s.graphEdges.find((e) => e.id === edgeId)));
  const updateGraphEdge = useAppStore((s) => s.updateGraphEdge);

  if (!edge) return <p className="text-sm text-[hsl(var(--muted-foreground))]">Edge not found.</p>;

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-[hsl(var(--muted-foreground))]">Label</label>
        <input
          value={edge.label}
          onChange={(e) => void updateGraphEdge(edgeId, { label: e.target.value })}
          className="mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none"
        />
      </div>
      <div>
        <label className="text-xs text-[hsl(var(--muted-foreground))]">Edge Type</label>
        <select
          value={edge.edgeType}
          onChange={(e) => void updateGraphEdge(edgeId, { edgeType: e.target.value as EdgeType, label: e.target.value })}
          className="mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none"
        >
          {EDGE_TYPES.map((et) => (
            <option key={et} value={et}>{et}</option>
          ))}
        </select>
      </div>
    </div>
  );
});
