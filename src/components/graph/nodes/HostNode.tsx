import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { Monitor } from 'lucide-react';

interface HostNodeData {
  label: string;
  hostname: string;
  ip: string;
  os: string;
  openPorts: number[];
  highlighted: boolean;
  [key: string]: unknown;
}

export const HostNode = memo(function HostNode({ data, selected }: NodeProps) {
  const d = data as unknown as HostNodeData;
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
        <Monitor size={14} className="text-neutral-400" />
        <span className="text-xs font-semibold">{d.label}</span>
      </div>
      {d.ip && <div className="mt-1 text-[10px] text-neutral-400/80">{d.ip}</div>}
      {d.os && <div className="text-[10px] text-neutral-400/80">{d.os}</div>}
      {d.openPorts?.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {d.openPorts.map((port: number) => (
            <span key={port} className="rounded-full bg-[hsl(var(--muted))] px-1.5 text-[9px] text-[hsl(var(--muted-foreground))]">
              {port}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-neutral-400" />
    </div>
  );
});
