import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { Key } from 'lucide-react';

interface CredentialNodeData {
  label: string;
  username: string;
  secret: string;
  source: string;
  highlighted: boolean;
  [key: string]: unknown;
}

export const CredentialNode = memo(function CredentialNode({ data, selected }: NodeProps) {
  const d = data as unknown as CredentialNodeData;
  return (
    <div
      className={cn(
        'min-w-[150px] rounded-xl border bg-[hsl(var(--card))] p-3 text-[hsl(var(--card-foreground))] shadow-md',
        selected ? 'border-[hsl(var(--primary))] ring-1 ring-[hsl(var(--primary))]' : 'border-[hsl(var(--border))]',
        d.highlighted && 'ring-2 ring-[hsl(var(--primary))]'
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-neutral-400" />
      <div className="flex items-center gap-2">
        <Key size={14} className="text-neutral-400" />
        <span className="text-xs font-semibold">{d.label}</span>
      </div>
      {d.username && <div className="mt-1 text-[10px] text-neutral-400/80">{d.username}</div>}
      {d.source && <div className="text-[10px] text-neutral-400/80">from: {d.source}</div>}
      <Handle type="source" position={Position.Bottom} className="!bg-neutral-400" />
    </div>
  );
});
