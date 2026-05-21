import { type DragEvent, memo, useCallback } from 'react';
import { Monitor, Key, Cog, Bug, ArrowRightLeft } from 'lucide-react';
import type { NodeType } from '@/types';

const paletteItems: { type: NodeType; label: string; icon: React.ReactNode; color: string }[] = [
  { type: 'host', label: 'Host', icon: <Monitor size={12} />, color: 'border-neutral-500/60 text-neutral-400' },
  { type: 'credential', label: 'Credential', icon: <Key size={12} />, color: 'border-neutral-500/60 text-neutral-400' },
  { type: 'service', label: 'Service', icon: <Cog size={12} />, color: 'border-neutral-500/60 text-neutral-400' },
  { type: 'finding', label: 'Finding', icon: <Bug size={12} />, color: 'border-neutral-500/60 text-neutral-400' },
  { type: 'pivot', label: 'Pivot', icon: <ArrowRightLeft size={12} />, color: 'border-neutral-500/60 text-neutral-400' },
];

export const NodePalette = memo(function NodePalette({ onDrop: _onDrop }: { onDrop: (type: NodeType, position: { x: number; y: number }) => void }) {
  const onDragStart = useCallback((event: DragEvent, type: NodeType) => {
    event.dataTransfer.setData('application/reactflow-type', type);
    event.dataTransfer.effectAllowed = 'move';
  }, []);

  return (
    <div className="flex gap-1 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-1 shadow-md">
      {paletteItems.map((item) => (
        <div
          key={item.type}
          draggable
          onDragStart={(e) => onDragStart(e, item.type)}
          className={`flex cursor-grab items-center gap-1.5 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 py-1 text-[10px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]`}
          title={`Drag to add ${item.label}`}
        >
          {item.icon}
          <span className="uppercase tracking-wider">{item.label}</span>
        </div>
      ))}
    </div>
  );
});
