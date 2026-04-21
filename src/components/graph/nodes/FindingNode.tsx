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

const severityConfig: Record<string, { bg: string; border: string; bar: string; text: string; badge: string }> = {
  critical: { bg: 'bg-[#1a1a1a]', border: 'border-purple-500', bar: 'bg-purple-500', text: 'text-purple-400', badge: 'bg-purple-500/30 text-purple-300' },
  high:     { bg: 'bg-[#1a1a1a]', border: 'border-red-500',    bar: 'bg-red-500',    text: 'text-red-400',    badge: 'bg-red-500/30 text-red-300' },
  medium:   { bg: 'bg-[#1a1a1a]', border: 'border-orange-500', bar: 'bg-orange-500', text: 'text-orange-400', badge: 'bg-orange-500/30 text-orange-300' },
  low:      { bg: 'bg-[#1a1a1a]', border: 'border-yellow-500', bar: 'bg-yellow-500', text: 'text-yellow-400', badge: 'bg-yellow-500/30 text-yellow-300' },
  info:     { bg: 'bg-[#1a1a1a]', border: 'border-blue-500',   bar: 'bg-blue-500',   text: 'text-blue-400',   badge: 'bg-blue-500/30 text-blue-300' },
};

export const FindingNode = memo(function FindingNode({ data, selected }: NodeProps) {
  const d = data as unknown as FindingNodeData;
  const sev = d.severity ?? 'info';
  const cfg = severityConfig[sev] ?? severityConfig['info']!;

  return (
    <div
      className={cn(
        'w-[160px] border text-white relative',
        cfg.bg,
        cfg.border,
        selected && 'ring-1 ring-[hsl(42,76%,46%)]',
        d.highlighted && 'ring-2 ring-[hsl(42,76%,46%)]'
      )}
    >
      {/* Severity color bar at top */}
      <div className={cn('h-1 w-full', cfg.bar)} />
      <Handle type="target" position={Position.Top} className={cn('!bg-current', cfg.text)} />
      <div className="p-3">
        <div className="flex items-center gap-2">
          <Bug size={14} className={cfg.text} />
          <span className="text-xs font-semibold truncate">{d.label}</span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className={cn('px-1.5 py-0.5 text-[9px] font-bold uppercase', cfg.badge)}>{sev}</span>
          {d.cvss > 0 && <span className="text-[10px] text-neutral-400">CVSS {d.cvss}</span>}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className={cn('!bg-current', cfg.text)} />
    </div>
  );
});
