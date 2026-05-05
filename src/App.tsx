import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores';
import { LeftSidebar } from '@/components/sidebar/LeftSidebar';
import { RightSidebar } from '@/components/sidebar/RightSidebar';
import { TabBar } from '@/components/ui/TabBar';
import { SplitContainer } from '@/components/ui/SplitContainer';
import { CommandPalette } from '@/components/ui/CommandPalette';
import { seedDemoWorkspace } from '@/db/seed';
import { useAuthStore } from '@/auth/auth-store';
import { LoginScreen } from '@/auth/LoginScreen';
import { getSharedDoc } from '@/realtime/shared-doc';
import { bindSharedSubscriptions } from '@/stores/shared-bindings';
import { getActiveMilkdownEditor, hasMilkdownSelection } from '@/lib/active-editor';
import { callCommand } from '@milkdown/utils';

export function App() {
  const authStatus = useAuthStore((s) => s.status);
  const bootstrap = useAuthStore((s) => s.bootstrap);

  // Validate any stored token on first mount.
  useEffect(() => { void bootstrap(); }, [bootstrap]);

  if (authStatus === 'unknown') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[hsl(var(--background))] text-white/60">
        Loading…
      </div>
    );
  }
  if (authStatus === 'unauthenticated') {
    return <LoginScreen />;
  }
  return <AuthedApp />;
}

function AuthedApp() {
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

  // On initial mount, auto-collapse the right Properties sidebar when the
  // viewport is narrow so the main editor stays readable. Runs once —
  // after the user opens it manually we leave their preference alone.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const NARROW_BREAKPOINT = 1280;
    if (window.innerWidth < NARROW_BREAKPOINT) {
      const st = useAppStore.getState();
      if (st.rightSidebarOpen) st.toggleRightSidebar();
    }
    // Intentionally empty deps — only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wait for the shared Yjs doc to load (IndexedDB cache + initial WS sync)
  // before populating the store. Otherwise we'd flash an empty sidebar and
  // potentially seed demo data on top of someone else's workspace.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const c = getSharedDoc();
    let cancelled = false;
    const unsubscribe = bindSharedSubscriptions();
    void c.whenReady.then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    void loadWorkspaces();
  }, [ready, loadWorkspaces]);

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
        // If the user has selected text inside the markdown editor, hijack
        // Ctrl+K for inline-link insertion (matches Notion / VS Code-style
        // expectations) instead of opening the command palette.
        if (hasMilkdownSelection()) {
          const editor = getActiveMilkdownEditor();
          if (editor) {
            e.preventDefault();
            const href = window.prompt('Link URL');
            if (href) {
              editor.action(callCommand('ToggleLink', { href, title: '' }));
            }
            return;
          }
        }
        e.preventDefault();
        const st = useAppStore.getState();
        st.setCommandPaletteOpen(!st.commandPaletteOpen);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ───────────────────────────────────────────────────────────────────────
  // Browser back/forward navigation between tabs.
  //
  // Each time the active tab changes by user action we push a history
  // entry tagged with that tab id. When the user clicks the browser's
  // back/forward arrows we read the tab id from the popstate event and
  // reactivate it WITHOUT pushing a new entry (otherwise back would
  // immediately undo itself).
  // ───────────────────────────────────────────────────────────────────────
  const lastActiveTabId = useRef<string | null>(null);
  const isPopping = useRef(false);
  useEffect(() => {
    // Seed the initial entry with the current tab id so the first push
    // doesn't lose the starting state.
    const initial = useAppStore.getState().activeTabId;
    lastActiveTabId.current = initial;
    if (typeof window !== 'undefined' && window.history.state?.alysaTabId == null) {
      window.history.replaceState(
        { ...(window.history.state ?? {}), alysaTabId: initial },
        '',
      );
    }

    const onPop = (e: PopStateEvent) => {
      const tabId = (e.state && (e.state as { alysaTabId?: string }).alysaTabId) ?? null;
      if (!tabId) return;
      const st = useAppStore.getState();
      if (!st.tabs.some((t) => t.id === tabId)) return;
      if (st.activeTabId === tabId) return;
      isPopping.current = true;
      st.setActiveTab(tabId);
      // Reset the guard on the next tick after the store update flushes.
      queueMicrotask(() => { isPopping.current = false; });
    };
    window.addEventListener('popstate', onPop);

    const unsub = useAppStore.subscribe((s, prev) => {
      if (s.activeTabId === prev.activeTabId) return;
      const next = s.activeTabId;
      if (next === lastActiveTabId.current) return;
      lastActiveTabId.current = next;
      if (isPopping.current) return;
      if (!next) return;
      window.history.pushState({ alysaTabId: next }, '');
    });

    return () => {
      window.removeEventListener('popstate', onPop);
      unsub();
    };
  }, []);

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

  // Auto-seed if no workspaces (only after the shared doc has loaded so
  // we don't race with another user's data and create duplicates).
  useEffect(() => {
    if (!ready) return;
    if (workspaces.length === 0) {
      void seedDemoWorkspace().then(() => loadWorkspaces());
    }
  }, [ready, workspaces.length, loadWorkspaces]);

  if (!ready) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[hsl(var(--background))] text-white/60">
        Connecting…
      </div>
    );
  }

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
