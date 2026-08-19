import { useCallback, useRef, useState, memo } from 'react';
import { useAppStore } from '@/stores';
import type { PaneNode, LeafPane, SplitPane, TabItem, DropPosition } from '@/types';
import { PageEditor } from '@/components/editor/PageEditor';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { NmapScanView, NmapMachineView } from '@/components/nmap/NmapScanView';
import { FindingsCollector } from '@/components/findings/FindingsCollector';
import { AttackTimeline } from '@/components/findings/AttackTimeline';
import { TypstView } from '@/components/typst/TypstView';
import { AiAssistant } from '@/components/ai/AiAssistant';
import { CommandLogView } from '@/components/cmdlog/CommandLogView';
import { FileText, Network, Radar, Monitor, X, Bug, Clock, FileType2, Sparkles, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';

export const TAB_DRAG_TYPE = 'application/x-btct-tab';

// ── Main entry ──

export function SplitContainer() {
  const paneLayout = useAppStore((s) => s.paneLayout);
  const tabs = useAppStore((s) => s.tabs);

  if (tabs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-medium text-white">Been There, Conquered That</h2>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            Open a page or attack narrative from the sidebar, or press{' '}
            <kbd className="rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 text-xs">Ctrl+K</kbd> for the command palette.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden">
      <PaneRenderer node={paneLayout} />
    </div>
  );
}

// ── Recursive renderer ──

function PaneRenderer({ node }: { node: PaneNode }) {
  if (node.type === 'leaf') return <PaneLeaf pane={node} />;
  return <PaneSplit split={node} />;
}

// ── Split node: two children with a draggable resize handle ──

function PaneSplit({ split }: { split: SplitPane }) {
  const updateSplitRatio = useAppStore((s) => s.updateSplitRatio);
  const containerRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);

  const isH = split.direction === 'horizontal';

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing(true);

      // Write pane sizes straight to the DOM during the drag and commit the
      // ratio to the store only on mouseup. Driving the store per mousemove
      // produced a new paneLayout object on every event, which (a) fired the
      // synchronous localStorage persist and (b) re-rendered every mounted
      // tab view (Milkdown, React Flow, Typst). One rAF-throttled style
      // write per frame instead. Mirrors TypstView's pane-resize pattern.
      const dim = isH ? 'width' : 'height';
      let latest = split.ratio;
      let frame = 0;
      const apply = () => {
        frame = 0;
        if (firstRef.current) firstRef.current.style[dim] = `calc(${latest * 100}% - 2px)`;
        if (secondRef.current) secondRef.current.style[dim] = `calc(${(1 - latest) * 100}% - 2px)`;
      };

      const onMove = (ev: MouseEvent) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const ratio = isH
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
        latest = Math.min(0.9, Math.max(0.1, ratio));
        if (!frame) frame = requestAnimationFrame(apply);
      };

      const onUp = () => {
        if (frame) cancelAnimationFrame(frame);
        setResizing(false);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        updateSplitRatio(split.id, latest);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [isH, split.id, split.ratio, updateSplitRatio],
  );

  return (
    <div ref={containerRef} className={cn('flex h-full w-full', isH ? 'flex-row' : 'flex-col')}>
      <div
        ref={firstRef}
        style={{ [isH ? 'width' : 'height']: `calc(${split.ratio * 100}% - 2px)` }}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        <PaneRenderer node={split.children[0]} />
      </div>
      <div
        onMouseDown={handleMouseDown}
        className={cn(
          'shrink-0 bg-[hsl(var(--border))] hover:bg-[hsl(var(--primary))] transition-colors z-10',
          isH ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
          resizing && 'bg-[hsl(var(--primary))]',
        )}
      />
      <div
        ref={secondRef}
        style={{ [isH ? 'width' : 'height']: `calc(${(1 - split.ratio) * 100}% - 2px)` }}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        <PaneRenderer node={split.children[1]} />
      </div>
    </div>
  );
}

// ── Leaf pane: tab strip + content + drop zones ──

function PaneLeaf({ pane }: { pane: LeafPane }) {
  const tabs = useAppStore((s) => s.tabs);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const setActivePane = useAppStore((s) => s.setActivePane);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const moveTabToPane = useAppStore((s) => s.moveTabToPane);
  const paneLayout = useAppStore((s) => s.paneLayout);

  const [dropZone, setDropZone] = useState<DropPosition | null>(null);
  const leafRef = useRef<HTMLDivElement>(null);
  const dragCounter = useRef(0);

  const hasSplits = paneLayout.type === 'split';
  const paneTabs = pane.tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean) as TabItem[];
  const activeTab = paneTabs.find((t) => t.id === pane.activeTabId) ?? paneTabs[0] ?? null;
  const isActive = activePaneId === pane.id;

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const rect = leafRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    // Edge zones: 20% from each edge
    if (x < 0.2) setDropZone('left');
    else if (x > 0.8) setDropZone('right');
    else if (y < 0.2) setDropZone('top');
    else if (y > 0.8) setDropZone('bottom');
    else setDropZone('center');
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const tabId = e.dataTransfer.getData(TAB_DRAG_TYPE);
      if (!tabId || !dropZone) return;
      e.preventDefault();
      moveTabToPane(tabId, pane.id, dropZone);
      setDropZone(null);
      dragCounter.current = 0;
    },
    [dropZone, moveTabToPane, pane.id],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
    e.preventDefault();
    dragCounter.current += 1;
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      setDropZone(null);
      dragCounter.current = 0;
    }
  }, []);

  return (
    <div
      ref={leafRef}
      className={cn(
        'relative flex h-full w-full flex-col',
        isActive && hasSplits && 'rounded-lg ring-1 ring-inset ring-[hsl(var(--primary))]/50',
      )}
      onClick={() => setActivePane(pane.id)}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
    >
      {/* Per-pane tab strip (only shown when splits exist — global TabBar handles single-pane tabs) */}
      {hasSplits && paneTabs.length > 0 && (
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2">
          {paneTabs.map((tab) => (
            <PaneTabChip
              key={tab.id}
              tab={tab}
              active={tab.id === activeTab?.id}
              onActivate={() => setActiveTab(tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab?.kind === 'page' && <PageEditor pageId={activeTab.entityId} />}
        {activeTab?.kind === 'graph' && <GraphCanvas graphId={activeTab.entityId} />}
        {activeTab?.kind === 'nmap' && <NmapScanView scanId={activeTab.entityId} />}
        {activeTab?.kind === 'nmap-machine' && <NmapMachineView machineId={activeTab.entityId} />}
        {activeTab?.kind === 'findings' && <FindingsCollector />}
        {activeTab?.kind === 'timeline' && <AttackTimeline />}
        {activeTab?.kind === 'typst' && <TypstView />}
        {activeTab?.kind === 'ai' && <AiAssistant />}
        {activeTab?.kind === 'cmdlog' && <CommandLogView />}
        {!activeTab && (
          <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">
            Drop a tab here
          </div>
        )}
      </div>

      {/* Drop zone overlay */}
      {dropZone && <DropZoneOverlay zone={dropZone} />}
    </div>
  );
}

// ── Per-pane tab chip ──

const PaneTabChip = memo(function PaneTabChip({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: TabItem;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
      e.dataTransfer.effectAllowed = 'move';
    },
    [tab.id],
  );

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={onActivate}
      className={cn(
        'group flex shrink-0 cursor-grab items-center gap-1.5 rounded-full px-3 py-1 text-[10px] transition-colors active:cursor-grabbing',
        active
          ? 'bg-[hsl(var(--accent))] text-[hsl(var(--foreground))]'
          : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]/60',
      )}
    >
      {tab.kind === 'page' ? <FileText size={9} /> : tab.kind === 'nmap-machine' ? <Monitor size={9} /> : tab.kind === 'nmap' ? <Radar size={9} /> : tab.kind === 'findings' ? <Bug size={9} /> : tab.kind === 'timeline' ? <Clock size={9} /> : tab.kind === 'typst' ? <FileType2 size={9} /> : tab.kind === 'ai' ? <Sparkles size={9} /> : tab.kind === 'cmdlog' ? <Terminal size={9} /> : <Network size={9} />}
      <span className="max-w-[100px] truncate">{tab.title}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="ml-0.5 hidden rounded-full p-0.5 hover:bg-[hsl(var(--destructive))]/30 group-hover:block"
      >
        <X size={8} />
      </button>
    </div>
  );
});

// ── Drop zone visual overlay ──

function DropZoneOverlay({ zone }: { zone: DropPosition }) {
  const base = 'absolute pointer-events-none rounded-xl bg-[hsl(var(--primary))]/15 border-2 border-[hsl(var(--primary))]/40 transition-all duration-100';
  const style: Record<DropPosition, string> = {
    left: `${base} inset-y-0 left-0 w-1/2`,
    right: `${base} inset-y-0 right-0 w-1/2`,
    top: `${base} inset-x-0 top-0 h-1/2`,
    bottom: `${base} inset-x-0 bottom-0 h-1/2`,
    center: `${base} inset-0`,
  };
  return <div className={style[zone]} />;
}
