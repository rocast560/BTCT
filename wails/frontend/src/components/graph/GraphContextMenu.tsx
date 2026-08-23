import { memo, useEffect, useRef, useState } from 'react';
import { EDGE_TYPES, type EdgeType, type AttackChain } from '@/types';

interface GraphContextMenuProps {
  x: number;
  y: number;
  nodeId?: string;
  edgeId?: string;
  nodeType?: string;
  hasLinkedNmap?: boolean;
  pathStartId: string | null;
  selectedNodeIds: string[];
  chainsInGraph: AttackChain[];
  onAction: (action: string) => void;
  onSetEdgeType: (edgeId: string, edgeType: EdgeType) => void;
  onClose: () => void;
}

export const GraphContextMenu = memo(function GraphContextMenu({ x, y, nodeId, edgeId, nodeType, hasLinkedNmap, pathStartId, selectedNodeIds, chainsInGraph, onAction, onSetEdgeType, onClose }: GraphContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [showChainSubmenu, setShowChainSubmenu] = useState(false);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const multiSelect = selectedNodeIds.length >= 2;

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', top: y, left: x }}
      className="z-50 min-w-[180px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--popover))] p-1 shadow-xl"
    >
      {nodeId && (
        <>
          <MenuItem label="Open Page" onClick={() => onAction('open-page')} />
          {nodeType === 'host' && hasLinkedNmap && (
            <MenuItem label="Go to Nmap" onClick={() => onAction('go-to-nmap')} />
          )}
          <MenuItem label="Set as Path Start" onClick={() => onAction('set-path-start')} />
          {pathStartId && pathStartId !== nodeId && (
            <MenuItem label="Set as Path End (Highlight)" onClick={() => onAction('set-path-end')} />
          )}
          {multiSelect && (
            <ChainSubmenu
              open={showChainSubmenu}
              setOpen={setShowChainSubmenu}
              count={selectedNodeIds.length}
              chains={chainsInGraph}
              onAction={onAction}
            />
          )}
          <div className="my-1 h-px bg-[hsl(var(--border))]" />
          <MenuItem label="Delete Node" onClick={() => onAction('delete-node')} destructive />
        </>
      )}
      {edgeId && (
        <>
          <div className="px-2 py-1 text-xs text-[hsl(var(--muted-foreground))]">Edge Type</div>
          {EDGE_TYPES.map((et) => (
            <MenuItem key={et} label={et} onClick={() => onSetEdgeType(edgeId, et)} />
          ))}
          <div className="my-1 h-px bg-[hsl(var(--border))]" />
          <MenuItem label="Delete Edge" onClick={() => onAction('delete-edge')} destructive />
        </>
      )}
      {!nodeId && !edgeId && (
        <>
          {multiSelect && (
            <>
              <ChainSubmenu
                open={showChainSubmenu}
                setOpen={setShowChainSubmenu}
                count={selectedNodeIds.length}
                chains={chainsInGraph}
                onAction={onAction}
              />
              <div className="my-1 h-px bg-[hsl(var(--border))]" />
            </>
          )}
          <div className="px-2 py-1 text-xs text-[hsl(var(--muted-foreground))]">Add Node</div>
          <MenuItem label="Host" onClick={() => onAction('add-host')} />
          <MenuItem label="Credential" onClick={() => onAction('add-credential')} />
          <MenuItem label="Service" onClick={() => onAction('add-service')} />
          <MenuItem label="Finding" onClick={() => onAction('add-finding')} />
          <MenuItem label="Pivot" onClick={() => onAction('add-pivot')} />
        </>
      )}
    </div>
  );
});

const ChainSubmenu = memo(function ChainSubmenu({ open, setOpen, count, chains, onAction }: {
  open: boolean;
  setOpen: (v: boolean) => void;
  count: number;
  chains: AttackChain[];
  onAction: (action: string) => void;
}) {
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-[hsl(var(--accent))]"
        onClick={() => setOpen(!open)}
      >
        <span>Add {count} node{count === 1 ? '' : 's'} to Attack Chain</span>
        <span className="ml-2 text-[hsl(var(--muted-foreground))]">▶</span>
      </button>
      {open && (
        <div
          className="absolute left-full top-0 ml-1 min-w-[180px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--popover))] p-1 shadow-xl"
        >
          <MenuItem label="+ New chain…" onClick={() => onAction('chain:new')} />
          {chains.length > 0 && <div className="my-1 h-px bg-[hsl(var(--border))]" />}
          {chains.map((c) => (
            <MenuItem key={c.id} label={c.name} onClick={() => onAction(`chain:add:${c.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
});

const MenuItem = memo(function MenuItem({ label, onClick, destructive }: { label: string; onClick: () => void; destructive?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center rounded px-2 py-1.5 text-sm hover:bg-[hsl(var(--accent))] ${
        destructive ? 'text-red-400' : ''
      }`}
    >
      {label}
    </button>
  );
});
