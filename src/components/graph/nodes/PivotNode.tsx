import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { ArrowRightLeft } from 'lucide-react';

interface PivotNodeData {
  label: string;
  description: string;
  highlighted: boolean;
  [key: string]: unknown;
}

export const PivotNode = memo(function PivotNode({ data, selected }: NodeProps) {
  const d = data as unknown as PivotNodeData;
  return (
    <div
      className={cn(
        'min-w-[120px] border bg-[#1a1a1a] p-3 text-white',
        selected ? 'border-[hsl(42,76%,46%)] ring-1 ring-[hsl(42,76%,46%)]' : 'border-neutral-600/60',
        d.highlighted && 'ring-2 ring-[hsl(42,76%,46%)]'
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-neutral-400" />
      <div className="flex items-center gap-2">
        <ArrowRightLeft size={14} className="text-neutral-400" />
        <span className="text-xs font-semibold">{d.label}</span>
      </div>
      {d.description && <div className="mt-1 text-[10px] text-neutral-400/80">{d.description}</div>}
      <Handle type="source" position={Position.Bottom} className="!bg-neutral-400" />
    </div>
  );
});
