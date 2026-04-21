import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores';
import { X, FileText, Network, PanelLeftOpen, PanelRightOpen, Radar, Monitor, Bug, Clock } from 'lucide-react';
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

  return (
    <div className="flex h-9 items-center border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      {!leftSidebarOpen && (
        <button onClick={toggleLeftSidebar} className="shrink-0 p-1.5 hover:bg-[hsl(var(--accent))]" title="Open sidebar">
          <PanelLeftOpen size={14} />
        </button>
      )}
      <div className="flex flex-1 items-center overflow-x-auto">
        {!isSplit && tabs.map((tab) => (
          <div
            key={tab.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            className={cn(
              'group flex shrink-0 cursor-grab items-center gap-1.5 border-r border-[hsl(var(--border))] px-3 py-1.5 text-xs active:cursor-grabbing',
              activeTabId === tab.id
                ? 'bg-[hsl(var(--background))] text-[hsl(var(--foreground))] border-b-2 border-b-[hsl(var(--primary))]'
                : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
            )}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.kind === 'page' ? <FileText size={11} /> : tab.kind === 'nmap-machine' ? <Monitor size={11} /> : tab.kind === 'nmap' ? <Radar size={11} /> : tab.kind === 'findings' ? <Bug size={11} /> : tab.kind === 'timeline' ? <Clock size={11} /> : <Network size={11} />}
            <span className="max-w-[120px] truncate">{tab.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="ml-1 hidden p-0.5 hover:bg-[hsl(var(--destructive))] group-hover:block"
            >
              <X size={10} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-l border-[hsl(var(--border))] px-3">
        <LiveClock />
      </div>
      {!rightSidebarOpen && (
        <button onClick={toggleRightSidebar} className="shrink-0 p-1.5 hover:bg-[hsl(var(--accent))]" title="Open properties">
          <PanelRightOpen size={14} />
        </button>
      )}
    </div>
  );
}
