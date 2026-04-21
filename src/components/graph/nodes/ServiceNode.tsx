import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { Cog } from 'lucide-react';

interface ServiceNodeData {
  label: string;
  name: string;
  version: string;
  port: number;
  cves: string[];
  highlighted: boolean;
  [key: string]: unknown;
}

export const ServiceNode = memo(function ServiceNode({ data, selected }: NodeProps) {
  const d = data as unknown as ServiceNodeData;
  return (
    <div
      className={cn(
        'min-w-[150px] border bg-[#1a1a1a] p-3 text-white',
        selected ? 'border-[hsl(42,76%,46%)] ring-1 ring-[hsl(42,76%,46%)]' : 'border-neutral-600/60',
        d.highlighted && 'ring-2 ring-[hsl(42,76%,46%)]'
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-neutral-400" />
      <div className="flex items-center gap-2">
        <Cog size={14} className="text-neutral-400" />
        <span className="text-xs font-semibold">{d.label}</span>
      </div>
      {d.name && <div className="mt-1 text-[10px] text-neutral-400/80">{d.name} {d.version}</div>}
      {d.port > 0 && <div className="text-[10px] text-neutral-400/80">Port {d.port}</div>}
      {d.cves?.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {d.cves.map((cve: string) => (
            <span key={cve} className="bg-neutral-700/50 px-1 text-[9px] text-neutral-300">
              {cve}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-neutral-400" />
    </div>
  );
});
