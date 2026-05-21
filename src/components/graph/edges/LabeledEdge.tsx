import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useAppStore } from '@/stores';

interface LabeledEdgeData {
  label: string;
  edgeType: string;
  highlighted: boolean;
  [key: string]: unknown;
}

export const LabeledEdge = memo(function LabeledEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data } = props;
  const d = data as unknown as LabeledEdgeData | undefined;
  const updateGraphEdge = useAppStore((s) => s.updateGraphEdge);

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(d?.label ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync external label changes
  useEffect(() => {
    if (!editing) setValue(d?.label ?? '');
  }, [d?.label, editing]);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed !== (d?.label ?? '')) {
      void updateGraphEdge(id, { label: trimmed || undefined });
    }
  }, [value, d?.label, id, updateGraphEdge]);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="rounded-md bg-[hsl(var(--card))] px-1.5 py-0.5 text-[10px] text-[hsl(var(--foreground))] border border-[hsl(var(--border))] shadow-sm"
          onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
        >
          {editing ? (
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setValue(d?.label ?? ''); setEditing(false); } }}
              className="w-24 bg-transparent text-center text-[10px] outline-none"
            />
          ) : (
            <span className="cursor-text select-none">{d?.label || '—'}</span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
