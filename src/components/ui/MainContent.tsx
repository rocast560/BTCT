import { useAppStore } from '@/stores';
import { PageEditor } from '@/components/editor/PageEditor';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { NmapScanView } from '@/components/nmap/NmapScanView';
import { FindingsCollector } from '@/components/findings/FindingsCollector';
import { AttackTimeline } from '@/components/findings/AttackTimeline';

export function MainContent() {
  const { tabs, activeTabId } = useAppStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!activeTab) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-medium text-[hsl(var(--foreground))]">Been There, Conquered That</h2>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            Open a page or attack narrative from the sidebar, or press <kbd className="rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 text-xs">Ctrl+K</kbd> for the command palette.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden">
      {activeTab.kind === 'page' && <PageEditor pageId={activeTab.entityId} />}
      {activeTab.kind === 'graph' && <GraphCanvas graphId={activeTab.entityId} />}
      {activeTab.kind === 'nmap' && <NmapScanView scanId={activeTab.entityId} />}
      {activeTab.kind === 'findings' && <FindingsCollector />}
      {activeTab.kind === 'timeline' && <AttackTimeline />}
    </div>
  );
}
