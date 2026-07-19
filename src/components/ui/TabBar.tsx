import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores';
import { X, FileText, Network, PanelLeftOpen, PanelRightOpen, Radar, Monitor, Bug, Clock, FileType2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TAB_DRAG_TYPE } from './SplitContainer';

function LiveClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const fmt = now.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: '2-digit' }).toUpperCase()
    + ', ' + now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + 'Z';
  return <span className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{fmt}</span>;
}

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, leftSidebarOpen, rightSidebarOpen, toggleLeftSidebar, toggleRightSidebar, paneLayout } =
    useAppStore();

  const isSplit = paneLayout.type === 'split';

  // When the layout is split, each PaneLeaf renders its own tab strip and
  // the global TabBar's tab area is empty. Rendering the full h-10 bar in
  // that state leaves the clock floating in an orphaned row — looks like
  // dead space. Instead, when split:
  //   - if both sidebars are open, render nothing (per-pane strips own
  //     the chrome entirely)
  //   - if a sidebar is closed, render only the open-toggle on that side
  //     in a thin strip so the user can still reopen it
  if (isSplit) {
    if (leftSidebarOpen && rightSidebarOpen) return null;
    return (
      <div className="flex h-8 shrink-0 items-center border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2">
        {!leftSidebarOpen && (
          <button onClick={toggleLeftSidebar} className="shrink-0 rounded-md p-1.5 hover:bg-[hsl(var(--accent))]" title="Open sidebar">
            <PanelLeftOpen size={14} />
          </button>
        )}
        <div className="flex-1" />
        {!rightSidebarOpen && (
          <button onClick={toggleRightSidebar} className="shrink-0 rounded-md p-1.5 hover:bg-[hsl(var(--accent))]" title="Open properties">
            <PanelRightOpen size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-10 items-center gap-1 border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2">
      {!leftSidebarOpen && (
        <button onClick={toggleLeftSidebar} className="shrink-0 rounded-md p-1.5 hover:bg-[hsl(var(--accent))]" title="Open sidebar">
          <PanelLeftOpen size={14} />
        </button>
      )}
      <div className="flex flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            className={cn(
              'group flex shrink-0 cursor-grab items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors active:cursor-grabbing',
              activeTabId === tab.id
                ? 'bg-[hsl(var(--accent))] text-[hsl(var(--foreground))]'
                : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]/60'
            )}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.kind === 'page' ? <FileText size={11} /> : tab.kind === 'nmap-machine' ? <Monitor size={11} /> : tab.kind === 'nmap' ? <Radar size={11} /> : tab.kind === 'findings' ? <Bug size={11} /> : tab.kind === 'timeline' ? <Clock size={11} /> : tab.kind === 'typst' ? <FileType2 size={11} /> : tab.kind === 'ai' ? <Sparkles size={11} /> : <Network size={11} />}
            <span className="max-w-[140px] truncate">{tab.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="ml-1 hidden rounded-full p-0.5 hover:bg-[hsl(var(--destructive))]/30 group-hover:block"
            >
              <X size={10} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-l border-[hsl(var(--border))] pl-3 pr-1">
        <LiveClock />
      </div>
      {!rightSidebarOpen && (
        <button onClick={toggleRightSidebar} className="shrink-0 rounded-md p-1.5 hover:bg-[hsl(var(--accent))]" title="Open properties">
          <PanelRightOpen size={14} />
        </button>
      )}
    </div>
  );
}
