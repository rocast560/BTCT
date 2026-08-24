import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { Bug } from 'lucide-react';

interface FindingNodeData {
  label: string;
  title: string;
  severity: string;
  cvss: number;
  highlighted: boolean;
  [key: string]: unknown;
}

// Per-severity colours just for the inline icon + badge. The card frame
// itself stays neutral (matches HostNode / ServiceNode / etc.) so all
// node types look like a uniform family on the canvas; severity is
// communicated by the pill inside.
const severityConfig: Record<string, { text: string; badge: string }> = {
  critical: {
    text:  'text-[hsl(var(--status-purple))]',
    badge: 'bg-[hsl(var(--status-purple))]/25 text-[hsl(var(--status-purple))]',
  },
  high: {
    text:  'text-[hsl(var(--status-red))]',
    badge: 'bg-[hsl(var(--status-red))]/25 text-[hsl(var(--status-red))]',
  },
  medium: {
    text:  'text-[hsl(var(--status-amber))]',
    badge: 'bg-[hsl(var(--status-amber))]/25 text-[hsl(var(--status-amber))]',
  },
  low: {
    text:  'text-[hsl(var(--status-green))]',
    badge: 'bg-[hsl(var(--status-green))]/25 text-[hsl(var(--status-green))]',
  },
  info: {
    text:  'text-[hsl(var(--status-blue))]',
    badge: 'bg-[hsl(var(--status-blue))]/25 text-[hsl(var(--status-blue))]',
  },
};

export const FindingNode = memo(function FindingNode({ data, selected }: NodeProps) {
  const d = data as unknown as FindingNodeData;
  const sev = d.severity ?? 'info';
  const cfg = severityConfig[sev] ?? severityConfig['info']!;

  return (
    <div
      className={cn(
        'min-w-[160px] rounded-xl border bg-[hsl(var(--card))] p-3 text-[hsl(var(--card-foreground))] shadow-md',
        selected ? 'border-[hsl(var(--primary))] ring-1 ring-[hsl(var(--primary))]' : 'border-[hsl(var(--border))]',
        d.highlighted && 'ring-2 ring-[hsl(var(--primary))]'
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-neutral-400" />
      <div className="flex items-center gap-2">
        <Bug size={14} className={cfg.text} />
        <span className="text-xs font-semibold truncate">{d.label}</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide', cfg.badge)}>{sev}</span>
        {d.cvss > 0 && <span className="text-[10px] text-[hsl(var(--muted-foreground))]">CVSS {d.cvss}</span>}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-neutral-400" />
    </div>
  );
});
