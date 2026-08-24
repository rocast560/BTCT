import { memo } from 'react';
import { useAppStore } from '@/stores';
import { useShallow } from 'zustand/shallow';
import { EDGE_TYPES, type EdgeType } from '@/types';
import { textKey } from '@/realtime/shared-doc';
import { useYTextInput } from '@/realtime/use-y-text';

export const EdgeProperties = memo(function EdgeProperties({ edgeId }: { edgeId: string }) {
  const edge = useAppStore(useShallow((s) => s.graphEdges.find((e) => e.id === edgeId)));
  const updateGraphEdge = useAppStore((s) => s.updateGraphEdge);

  // Bind edge label to a Y.Text — concurrent edits merge with insert/delete deltas.
  const [labelValue, setLabelValue, labelRef] = useYTextInput(
    textKey('edge', edgeId, 'label'),
    edge?.label ?? '',
  );

  if (!edge) return <p className="text-sm text-[hsl(var(--muted-foreground))]">Edge not found.</p>;

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-[hsl(var(--muted-foreground))]">Label</label>
        <input
          ref={labelRef}
          value={labelValue}
          onChange={(e) => setLabelValue(e.target.value)}
          className="mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none"
        />
      </div>
      <div>
        <label className="text-xs text-[hsl(var(--muted-foreground))]">Edge Type</label>
        <select
          value={edge.edgeType}
          onChange={(e) => {
            const next = e.target.value as EdgeType;
            // Updating the edge type also resets the label to match the type;
            // write through the Y.Text so the label change is collaborative.
            void updateGraphEdge(edgeId, { edgeType: next });
            setLabelValue(next);
          }}
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
