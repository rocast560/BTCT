import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import type { SiteNodeType } from '@/types';
import { SITE_TYPE_META, statusColor } from '../site-visuals';

interface SiteNodeData {
  type: SiteNodeType;
  label: string;
  method: string;
  status: number | null;
  contentType: string;
  highlighted: boolean;
  [key: string]: unknown;
}

// One generic node styled by `type` (a crawl produces too many nodes to justify
// a bespoke component per kind). React Flow keys `nodeTypes` by the domain type
// string, so every SiteNodeType maps here.
export const SiteNode = memo(function SiteNode({ data, selected }: NodeProps) {
  const d = data as unknown as SiteNodeData;
  const meta = SITE_TYPE_META[d.type] ?? SITE_TYPE_META.page;
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        'min-w-[150px] max-w-[280px] rounded-lg border bg-[hsl(var(--card))] p-2.5 text-[hsl(var(--card-foreground))] shadow-md',
        selected ? 'border-[hsl(var(--primary))] ring-1 ring-[hsl(var(--primary))]' : 'border-[hsl(var(--border))]',
        d.highlighted && 'ring-2 ring-[hsl(var(--primary))]',
      )}
      style={{ borderLeft: `3px solid ${meta.color}` }}
    >
      <Handle type="target" position={Position.Left} className="!bg-neutral-400" />
      <div className="flex items-center gap-1.5">
        <Icon size={13} />
        <span className="truncate text-[11px] font-semibold" title={d.label}>{d.label}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {d.method && (
          <span className="rounded bg-[hsl(var(--muted))] px-1 text-[9px] font-mono uppercase text-[hsl(var(--muted-foreground))]">{d.method}</span>
        )}
        {d.status != null && (
          <span className="rounded px-1 text-[9px] font-mono" style={{ color: statusColor(d.status) }}>{d.status}</span>
        )}
        <span className="text-[9px] uppercase tracking-wide" style={{ color: meta.color }}>{meta.label}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-neutral-400" />
    </div>
  );
});
