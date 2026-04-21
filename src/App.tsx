import { useEffect } from 'react';
import { useAppStore } from '@/stores';
import { LeftSidebar } from '@/components/sidebar/LeftSidebar';
import { RightSidebar } from '@/components/sidebar/RightSidebar';
import { TabBar } from '@/components/ui/TabBar';
import { SplitContainer } from '@/components/ui/SplitContainer';
import { CommandPalette } from '@/components/ui/CommandPalette';
import { seedDemoWorkspace } from '@/db/seed';

export function App() {
  const {
    loadWorkspaces,
    activeWorkspaceId,
    loadPages,
    loadGraphs,
    loadChangeLogs,
    loadNmapScans,
    loadAttackChains,
    leftSidebarOpen,
    rightSidebarOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
    workspaces,
  } = useAppStore();

  useEffect(() => {
    const init = async () => {
      await loadWorkspaces();
    };
    void init();
  }, [loadWorkspaces]);

  useEffect(() => {
    if (activeWorkspaceId) {
      void loadPages();
      void loadGraphs();
      void loadChangeLogs();
      void loadNmapScans();
      void loadAttackChains();
    }
  }, [activeWorkspaceId, loadPages, loadGraphs, loadChangeLogs, loadNmapScans, loadAttackChains]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [commandPaletteOpen, setCommandPaletteOpen]);

  // Tab navigation: Left/Right arrows cycle tabs in active pane, Alt+W closes active tab.
  // Skip when user is typing in an input/textarea/contenteditable.
  useEffect(() => {
    const isEditableTarget = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (t.isContentEditable) return true;
      return false;
    };
    const handler = (e: KeyboardEvent) => {
      const altW = e.altKey && (e.key === 'w' || e.key === 'W');
      const isArrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      if (!altW && !isArrow) return;
      // Don't hijack typing, text selection, or modifier combos we don't own
      if (isEditableTarget(e.target)) return;
      if (isArrow && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) return;

      const state = useAppStore.getState();
      const { activeTabId, paneLayout, activePaneId, setActiveTab, closeTab } = state;
      // Resolve the current pane: prefer the pane containing the active tab,
      // fall back to activePaneId, then to the first leaf.
      const findLeafById = (node: typeof paneLayout, id: string | null): typeof paneLayout | null => {
        if (!id) return null;
        if (node.type === 'leaf') return node.id === id ? node : null;
        return findLeafById(node.children[0], id) ?? findLeafById(node.children[1], id);
      };
      const findLeafWithTab = (node: typeof paneLayout, tabId: string | null): typeof paneLayout | null => {
        if (!tabId) return null;
        if (node.type === 'leaf') return node.tabIds.includes(tabId) ? node : null;
        return findLeafWithTab(node.children[0], tabId) ?? findLeafWithTab(node.children[1], tabId);
      };
      const firstLeafOf = (node: typeof paneLayout): typeof paneLayout => {
        return node.type === 'leaf' ? node : firstLeafOf(node.children[0]);
      };
      const leaf =
        findLeafWithTab(paneLayout, activeTabId) ??
        findLeafById(paneLayout, activePaneId) ??
        firstLeafOf(paneLayout);
      if (leaf.type !== 'leaf') return;
      const tabIds = leaf.tabIds;
      if (tabIds.length === 0) return;
      const currentId = leaf.activeTabId ?? activeTabId;
      const idx = currentId ? tabIds.indexOf(currentId) : -1;

      if (altW) {
        e.preventDefault();
        const targetId = currentId && idx !== -1 ? currentId : tabIds[tabIds.length - 1];
        if (targetId) closeTab(targetId);
        return;
      }

      // Arrow navigation
      e.preventDefault();
      if (tabIds.length < 2) return;
      const safeIdx = idx === -1 ? 0 : idx;
      const nextIdx =
        e.key === 'ArrowLeft'
          ? (safeIdx - 1 + tabIds.length) % tabIds.length
          : (safeIdx + 1) % tabIds.length;
      const nextId = tabIds[nextIdx];
      if (nextId && nextId !== currentId) setActiveTab(nextId);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto-seed if no workspaces
  useEffect(() => {
    if (workspaces.length === 0) {
      void seedDemoWorkspace().then(() => loadWorkspaces());
    }
  }, [workspaces.length, loadWorkspaces]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      {leftSidebarOpen && <LeftSidebar />}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TabBar />
        <SplitContainer />
      </div>
      {rightSidebarOpen && <RightSidebar />}
      <CommandPalette />
    </div>
  );
}
