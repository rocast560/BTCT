import { useState, useRef, useEffect, useCallback } from 'react';
import { useAppStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore } from '@/auth/auth-store';
import { WorkspaceSelector } from '@/components/ui/WorkspaceSelector';
import { AdminPanel } from '@/components/sidebar/AdminPanel';
import { ProfileEditor } from '@/components/sidebar/ProfileEditor';
import { ThemePicker } from '@/components/sidebar/ThemePicker';
import { applyUiTheme, nextUiTheme, UI_THEMES } from '@/themes/registry';
import { resolvePrefs } from '@/lib/editor-prefs';
import {
  ChevronDown,
  ChevronRight,
  Network,
  Plus,
  Search,
  PanelLeftClose,
  Sun,
  Moon,
  Trash2,
  Pencil,
  Radar,
  Bug,
  FileText,
  FileType2,
  Clock,
  Link2,
  Shield,
  Layers,
  LogOut,
  Palette,
  Sparkles,
  Terminal,
} from 'lucide-react';
import type { Page, Graph, NmapScan, AttackChain } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { cn } from '@/lib/utils';

// Custom drag MIME for moving a page row into another page row (or out
// to the root level). Distinct from the tab drag MIME so the two flows
// don't ever collide.
const PAGE_DRAG_TYPE = 'application/x-btct-page';
const PAGES_EXPANDED_KEY = 'btct.pages.expanded.v1';

// Cycle guard: returns true if `candidateAncestor` already exists in
// `target`'s ancestor chain. Used before reparenting so we never let a
// user drag a parent into one of its own descendants.
function isAncestor(candidateAncestor: string, target: string, pages: Page[]): boolean {
  const byId = new Map(pages.map((p) => [p.id, p]));
  let cursor: string | null = target;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    if (cursor === candidateAncestor) return true;
    const node = byId.get(cursor);
    if (!node) break;
    cursor = node.parentId;
  }
  return false;
}

export function LeftSidebar() {
  const {
    pages,
    graphs,
    createPage,
    createGraph,
    deletePage,
    deleteGraph,
    openTab,
    searchQuery,
    setSearchQuery,
    runSearch,
    searchResults,
    toggleLeftSidebar,
    darkMode,
    toggleDarkMode,
    activeWorkspaceId,
    nmapScans,
    loadNmapScans,
    createNmapGroup,
    deleteNmapScan,
    renameNmapScan,
    leftSidebarWidth,
    setLeftSidebarWidth,
    updateGraph,
    attackChains,
    updateAttackChain,
    deleteAttackChain,
    ensureAttackChainPage,
    setPendingHighlightChainId,
  } = useAppStore(useShallow((s) => ({
    pages: s.pages,
    graphs: s.graphs,
    createPage: s.createPage,
    createGraph: s.createGraph,
    deletePage: s.deletePage,
    deleteGraph: s.deleteGraph,
    openTab: s.openTab,
    searchQuery: s.searchQuery,
    setSearchQuery: s.setSearchQuery,
    runSearch: s.runSearch,
    searchResults: s.searchResults,
    toggleLeftSidebar: s.toggleLeftSidebar,
    darkMode: s.darkMode,
    toggleDarkMode: s.toggleDarkMode,
    activeWorkspaceId: s.activeWorkspaceId,
    nmapScans: s.nmapScans,
    loadNmapScans: s.loadNmapScans,
    createNmapGroup: s.createNmapGroup,
    deleteNmapScan: s.deleteNmapScan,
    renameNmapScan: s.renameNmapScan,
    leftSidebarWidth: s.leftSidebarWidth,
    setLeftSidebarWidth: s.setLeftSidebarWidth,
    updateGraph: s.updateGraph,
    attackChains: s.attackChains,
    updateAttackChain: s.updateAttackChain,
    deleteAttackChain: s.deleteAttackChain,
    ensureAttackChainPage: s.ensureAttackChainPage,
    setPendingHighlightChainId: s.setPendingHighlightChainId,
  })));

  const [pagesExpanded, setPagesExpanded] = useState(true);
  const [narrativesExpanded, setNarrativesExpanded] = useState(true);
  const [nmapExpanded, setNmapExpanded] = useState(true);
  const [chainsExpanded, setChainsExpanded] = useState(true);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const authUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const updateProfile = useAuthStore((s) => s.updateProfile);

  // Interface theme toggle: applies instantly, then persists on the account
  // (and reverts if the save fails).
  const uiTheme = resolvePrefs(authUser).uiTheme;
  const cycleUiTheme = () => {
    const next = nextUiTheme(uiTheme);
    applyUiTheme(next);
    if (!authUser) return;
    const prefs = resolvePrefs(authUser);
    void updateProfile({ prefs: { ...prefs, uiTheme: next } }).catch(() => applyUiTheme(uiTheme));
  };

  // Per-page expansion state, persisted across reloads. Used to remember
  // which page-tree nodes the user has opened so subpages stay visible.
  const [expandedPages, setExpandedPages] = useState<Set<string>>(() => {
    if (typeof localStorage === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(PAGES_EXPANDED_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    return new Set();
  });
  const togglePageExpanded = useCallback((id: string) => {
    setExpandedPages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(PAGES_EXPANDED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const expandPage = useCallback((id: string) => {
    setExpandedPages((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      try { localStorage.setItem(PAGES_EXPANDED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const rootPages = pages.filter((p) => p.parentId === null && !p.isGraphPage);

  // Drop-zone state on the Pages section header: hovering with a page
  // drag here re-parents the dragged page back to root level.
  const [rootDropOver, setRootDropOver] = useState(false);
  const updatePageFromStore = useAppStore((s) => s.updatePage);
  const handleRootDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(PAGE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setRootDropOver(true);
  };
  const handleRootDrop = (e: React.DragEvent) => {
    const draggedId = e.dataTransfer.getData(PAGE_DRAG_TYPE);
    setRootDropOver(false);
    if (!draggedId) return;
    e.preventDefault();
    const dragged = pages.find((p) => p.id === draggedId);
    if (!dragged || dragged.parentId === null) return;
    void updatePageFromStore(draggedId, { parentId: null });
  };

  useEffect(() => {
    if (activeWorkspaceId) void loadNmapScans();
  }, [activeWorkspaceId, loadNmapScans]);

  const handleSearch = (value: string) => {
    setSearchQuery(value);
    void runSearch();
  };

  const handleCreatePage = async () => {
    if (!activeWorkspaceId) return;
    const page = await createPage(null, 'Untitled');
    openTab({ id: uuidv4(), kind: 'page', entityId: page.id, title: page.title });
  };

  const handleCreateGraph = async () => {
    if (!activeWorkspaceId) return;
    const graph = await createGraph('New Attack Narrative');
    openTab({ id: uuidv4(), kind: 'graph', entityId: graph.id, title: graph.name });
  };

  const openPage = (page: Page) => {
    openTab({ id: uuidv4(), kind: 'page', entityId: page.id, title: page.title });
  };

  const openGraph = (graph: Graph) => {
    openTab({ id: uuidv4(), kind: 'graph', entityId: graph.id, title: graph.name });
  };

  const openScan = (scan: NmapScan) => {
    openTab({ id: uuidv4(), kind: 'nmap', entityId: scan.id, title: scan.name });
  };

  const handleCreateGroup = async () => {
    const name = newGroupName.trim();
    if (!name || !activeWorkspaceId) return;
    const group = await createNmapGroup(name);
    setNewGroupName('');
    setCreatingGroup(false);
    openScan(group);
  };

  const openFindings = () => {
    openTab({ id: uuidv4(), kind: 'findings', entityId: 'findings', title: 'Findings Collector' });
  };

  const openTimeline = () => {
    openTab({ id: uuidv4(), kind: 'timeline', entityId: 'timeline', title: 'Attack Timeline' });
  };

  const openTypst = () => {
    openTab({ id: uuidv4(), kind: 'typst', entityId: 'typst', title: 'Typst' });
  };

  const openAi = () => {
    openTab({ id: uuidv4(), kind: 'ai', entityId: 'ai', title: 'Claude' });
  };

  const openCommandLog = () => {
    openTab({ id: uuidv4(), kind: 'cmdlog', entityId: 'cmdlog', title: 'Command Log' });
  };

  const openChain = async (chain: AttackChain) => {
    // Left-click opens (or lazily creates) the chain's writeup page so the
    // user can document the attack steps. Highlighting on the graph is now
    // an explicit right-click action — see `highlightChain`.
    let pageId = chain.linkedPageId;
    if (!pageId) {
      pageId = await ensureAttackChainPage(chain.id);
    }
    if (!pageId) return;
    openTab({ id: uuidv4(), kind: 'page', entityId: pageId, title: chain.name });
  };

  const highlightChain = (chain: AttackChain) => {
    const graph = graphs.find((g) => g.id === chain.graphId);
    if (!graph) return;
    setPendingHighlightChainId(chain.id);
    openTab({ id: uuidv4(), kind: 'graph', entityId: graph.id, title: graph.name });
  };

  // ── Resize handle ──
  const isResizing = useRef(false);
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = leftSidebarWidth;
    const onMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      setLeftSidebarWidth(startWidth + (ev.clientX - startX));
    };
    const onUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [leftSidebarWidth, setLeftSidebarWidth]);

  return (
    <div data-ui="sidebar" className="relative flex h-full flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--card))]" style={{ width: leftSidebarWidth }}>
      {/* Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-[hsl(var(--primary))] active:bg-[hsl(var(--primary))]"
      />
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <img src="/new-logo.png" alt="" className="h-5 w-5 rounded-md object-cover" aria-hidden />
          <span className="text-xs font-bold uppercase tracking-widest text-[hsl(var(--foreground))]">BTCT</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={cycleUiTheme}
            className="rounded-md p-1.5 hover:bg-[hsl(var(--accent))]"
            title={`Interface: ${UI_THEMES.find((t) => t.id === uiTheme)?.label ?? uiTheme}. Click to switch.`}
          >
            <Layers size={13} />
          </button>
          <button onClick={toggleDarkMode} className="rounded-md p-1.5 hover:bg-[hsl(var(--accent))]" title="Toggle theme">
            {darkMode ? <Sun size={13} /> : <Moon size={13} />}
          </button>
          <button onClick={toggleLeftSidebar} className="rounded-md p-1.5 hover:bg-[hsl(var(--accent))]" title="Close sidebar">
            <PanelLeftClose size={13} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5">
          <Search size={14} className="text-[hsl(var(--muted-foreground))]" />
          <input
            type="text"
            placeholder="Search pages..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus-visible:outline-none"
          />
        </div>
      </div>

      {/* Search results */}
      {searchQuery.trim() && (
        <div className="border-b border-[hsl(var(--border))] px-3 pb-2">
          <span className="text-xs text-[hsl(var(--muted-foreground))]">Results</span>
          {searchResults.map((p) => (
            <button
              key={p.id}
              onClick={() => openPage(p)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-[hsl(var(--accent))] focus:bg-transparent focus-visible:bg-[hsl(var(--accent))]/60"
            >
              <FileText size={12} className="text-[hsl(var(--status-blue))]" />
              <span className="truncate">{p.title}</span>
            </button>
          ))}
          {searchResults.length === 0 && <span className="text-xs text-[hsl(var(--muted-foreground))]">No results</span>}
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-1">
        {/* Pages section */}
        <div className="py-1">
          <div
            className={cn(
              'flex w-full items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2 transition-colors',
              rootDropOver && 'bg-[hsl(var(--primary))]/15',
            )}
            onDragOver={handleRootDragOver}
            onDragLeave={() => setRootDropOver(false)}
            onDrop={handleRootDrop}
          >
            <button
              onClick={() => setPagesExpanded(!pagesExpanded)}
              className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--foreground))]"
            >
              Pages
              {pagesExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </button>
            <button onClick={(e) => { e.stopPropagation(); void handleCreatePage(); }} className="p-0.5 hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]">
              <Plus size={12} />
            </button>
          </div>
          {pagesExpanded && (
            <div className="flex flex-col gap-1 px-2 pt-1">
              <button
                onClick={openFindings}
                className="flex w-full items-center gap-1.5 rounded-lg border border-[hsl(var(--status-red))]/30 bg-[hsl(var(--status-red))]/10 px-2.5 py-1.5 text-left text-[11px] hover:bg-[hsl(var(--status-red))]/20"
              >
                <Bug size={12} className="text-[hsl(var(--status-red))]" />
                <span className="truncate">Findings</span>
              </button>
              <button
                onClick={openTimeline}
                className="flex w-full items-center gap-1.5 rounded-lg border border-[hsl(var(--status-amber))]/30 bg-[hsl(var(--status-amber))]/10 px-2.5 py-1.5 text-left text-[11px] hover:bg-[hsl(var(--status-amber))]/20"
              >
                <Clock size={12} className="text-[hsl(var(--status-amber))]" />
                <span className="truncate">Attack Timeline</span>
              </button>
              <button
                onClick={openAi}
                className="flex w-full items-center gap-1.5 rounded-lg border border-[hsl(var(--primary))]/30 bg-[hsl(var(--primary))]/10 px-2.5 py-1.5 text-left text-[11px] hover:bg-[hsl(var(--primary))]/20"
              >
                <Sparkles size={12} className="text-[hsl(var(--primary))]" />
                <span className="truncate">Claude Assistant</span>
              </button>
              <button
                onClick={openTypst}
                className="flex w-full items-center gap-1.5 rounded-lg border border-[hsl(var(--status-purple))]/30 bg-[hsl(var(--status-purple))]/10 px-2.5 py-1.5 text-left text-[11px] hover:bg-[hsl(var(--status-purple))]/20"
              >
                <FileType2 size={12} className="text-[hsl(var(--status-purple))]" />
                <span className="truncate">Typst</span>
              </button>
              <button
                onClick={openCommandLog}
                className="flex w-full items-center gap-1.5 rounded-lg border border-[hsl(var(--status-green))]/30 bg-[hsl(var(--status-green))]/10 px-2.5 py-1.5 text-left text-[11px] hover:bg-[hsl(var(--status-green))]/20"
              >
                <Terminal size={12} className="text-[hsl(var(--status-green))]" />
                <span className="truncate">Command Log</span>
              </button>
              {rootPages.map((page) => (
                <PageTreeItem
                  key={page.id}
                  page={page}
                  pages={pages}
                  openPage={openPage}
                  deletePage={deletePage}
                  depth={0}
                  expandedPages={expandedPages}
                  toggleExpanded={togglePageExpanded}
                  expandPage={expandPage}
                />
              ))}
              {rootPages.length === 0 && (
                <span className="px-2 py-1 text-xs text-[hsl(var(--muted-foreground))]">No pages yet</span>
              )}
            </div>
          )}
        </div>

        {/* Attack Narratives section */}
        <div className="py-1">
          <div className="flex w-full items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2">
            <button
              onClick={() => setNarrativesExpanded(!narrativesExpanded)}
              className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--foreground))]"
            >
              Attack Narratives
              {narrativesExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </button>
            <button onClick={(e) => { e.stopPropagation(); void handleCreateGraph(); }} className="p-0.5 hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]">
              <Plus size={12} />
            </button>
          </div>
          {narrativesExpanded && (
            <div className="flex flex-col gap-1 px-2 pt-1">
              {graphs.map((graph) => (
                <NarrativeItem key={graph.id} graph={graph} openGraph={openGraph} deleteGraph={deleteGraph} updateGraph={updateGraph} />
              ))}
              {graphs.length === 0 && (
                <span className="px-2 py-1 text-xs text-[hsl(var(--muted-foreground))]">No narratives yet</span>
              )}
            </div>
          )}
        </div>

        {/* Attack Chains section */}
        <div className="py-1">
          <div className="flex w-full items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2">
            <button
              onClick={() => setChainsExpanded(!chainsExpanded)}
              className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--foreground))]"
            >
              Attack Chains
              {chainsExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </button>
          </div>
          {chainsExpanded && (
            <div className="flex flex-col gap-1 px-2 pt-1">
              {attackChains.map((chain) => {
                const graph = graphs.find((g) => g.id === chain.graphId);
                return (
                  <AttackChainItem
                    key={chain.id}
                    chain={chain}
                    graphName={graph?.name ?? 'Unknown narrative'}
                    openChain={openChain}
                    highlightChain={highlightChain}
                    renameChain={(id, name) => updateAttackChain(id, { name })}
                    deleteChain={deleteAttackChain}
                  />
                );
              })}
              {attackChains.length === 0 && (
                <span className="px-2 py-1 text-xs text-[hsl(var(--muted-foreground))]">
                  Select 2+ nodes and right-click to create
                </span>
              )}
            </div>
          )}
        </div>

        {/* Nmap Scans section */}
        <div className="py-1">
          <div className="flex w-full items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2">
            <button
              onClick={() => setNmapExpanded(!nmapExpanded)}
              className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--foreground))]"
            >
              Nmap Scans
              {nmapExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </button>
            <button onClick={() => { setCreatingGroup(true); setNmapExpanded(true); }} className="p-0.5 hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]" title="Create group">
              <Plus size={12} />
            </button>
          </div>
          {nmapExpanded && (
            <div className="flex flex-col gap-1 px-2 pt-1">
              {creatingGroup && (
                <div className="flex w-full items-center gap-1.5 rounded-lg border border-[hsl(var(--status-green))]/30 bg-[hsl(var(--status-green))]/10 px-2.5 py-1.5">
                  <Radar size={12} className="shrink-0 text-[hsl(var(--status-green))]" />
                  <input
                    autoFocus
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateGroup(); if (e.key === 'Escape') { setCreatingGroup(false); setNewGroupName(''); } }}
                    onBlur={() => { if (!newGroupName.trim()) { setCreatingGroup(false); setNewGroupName(''); } }}
                    placeholder="Group name..."
                    className="min-w-0 flex-1 border-b border-[hsl(var(--primary))] bg-transparent text-[11px] outline-none"
                  />
                </div>
              )}
              {nmapScans.filter((scan) => scan.workspaceId === activeWorkspaceId).map((scan) => (
                <NmapScanItem key={scan.id} scan={scan} openScan={openScan} deleteNmapScan={deleteNmapScan} renameNmapScan={renameNmapScan} />
              ))}
              {nmapScans.filter((scan) => scan.workspaceId === activeWorkspaceId).length === 0 && !creatingGroup && (
                <span className="px-2 py-1 text-xs text-[hsl(var(--muted-foreground))]">No groups yet</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer: Workspace selector + signed-in user + admin panel */}
      <div className="flex flex-col gap-2 border-t border-[hsl(var(--border))] p-3">
        <WorkspaceSelector />

        {authUser && (
          <div className="flex items-center gap-2.5 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 py-2">
            <button
              onClick={() => setProfileEditorOpen(true)}
              title="Edit profile"
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
            >
              <span
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
                style={{ backgroundColor: authUser.color }}
                aria-hidden="true"
              >
                {authUser.username.charAt(0).toUpperCase()}
              </span>
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[12px] font-medium">{authUser.username}</span>
                <span className="truncate text-[9px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                  {authUser.isAdmin ? 'administrator' : 'signed in'}
                </span>
              </div>
            </button>
            <button
              onClick={logout}
              title="Log out"
              className="shrink-0 rounded p-1.5 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
            >
              <LogOut size={14} />
            </button>
          </div>
        )}

        {authUser?.isAdmin && (
          <div className="flex flex-col gap-1.5">
            <button
              onClick={() => setAdminPanelOpen(true)}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-[hsl(var(--status-amber))]/40 bg-[hsl(var(--status-amber))]/10 px-2 py-1.5 text-[11px] font-medium text-[hsl(var(--status-amber))] hover:bg-[hsl(var(--status-amber))]/20"
            >
              <Shield size={12} />
              <span>Admin Panel</span>
            </button>
            <button
              onClick={() => setThemePickerOpen(true)}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-[hsl(var(--primary))]/40 bg-[hsl(var(--primary))]/10 px-2 py-1.5 text-[11px] font-medium text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/20"
              title="Workspace accent, default heading colours and the theme lock"
            >
              <Palette size={12} />
              <span>Theme</span>
            </button>
          </div>
        )}
      </div>

      {adminPanelOpen && <AdminPanel onClose={() => setAdminPanelOpen(false)} />}
      {profileEditorOpen && <ProfileEditor onClose={() => setProfileEditorOpen(false)} />}
      {themePickerOpen && <ThemePicker onClose={() => setThemePickerOpen(false)} />}
    </div>
  );
}

function PageTreeItem({
  page,
  pages,
  openPage,
  deletePage,
  depth,
  expandedPages,
  toggleExpanded,
  expandPage,
}: {
  page: Page;
  pages: Page[];
  openPage: (p: Page) => void;
  deletePage: (id: string) => Promise<void>;
  depth: number;
  expandedPages: Set<string>;
  toggleExpanded: (id: string) => void;
  expandPage: (id: string) => void;
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [editingSlug, setEditingSlug] = useState(false);
  const [slugValue, setSlugValue] = useState(page.slug ?? '');
  const [renaming, setRenaming] = useState(false);
  const [nameValue, setNameValue] = useState(page.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const updatePage = useAppStore((s) => s.updatePage);
  const slugRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const children = pages.filter((p) => p.parentId === page.id);
  const hasChildren = children.length > 0;
  const isExpanded = expandedPages.has(page.id);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(PAGE_DRAG_TYPE, page.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(PAGE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const draggedId = e.dataTransfer.getData(PAGE_DRAG_TYPE);
    if (!draggedId || draggedId === page.id) return;
    // Cycle guard: refuse if the page we'd reparent is already an
    // ancestor of the drop target.
    if (isAncestor(draggedId, page.id, pages)) return;
    const dragged = pages.find((p) => p.id === draggedId);
    if (!dragged || dragged.parentId === page.id) return;
    void updatePage(draggedId, { parentId: page.id });
    // Auto-expand so the user sees the page they just dropped in.
    expandPage(page.id);
  };

  useEffect(() => {
    if (editingSlug && slugRef.current) slugRef.current.focus();
  }, [editingSlug]);

  useEffect(() => {
    if (renaming && nameRef.current) nameRef.current.focus();
  }, [renaming]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [ctxMenu]);

  const commitSlug = () => {
    setEditingSlug(false);
    const trimmed = slugValue.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/(^-|-$)/g, '');
    setSlugValue(trimmed);
    void updatePage(page.id, { slug: trimmed });
  };

  const commitRename = () => {
    setRenaming(false);
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== page.title) {
      void updatePage(page.id, { title: trimmed });
    } else {
      setNameValue(page.title);
    }
  };

  return (
    <div className="group relative">
      <div
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'flex w-full items-center rounded-lg border border-[hsl(var(--status-blue))]/30 bg-[hsl(var(--status-blue))]/10 hover:bg-[hsl(var(--status-blue))]/20',
          dragOver && 'ring-2 ring-[hsl(var(--primary))] ring-offset-1 ring-offset-[hsl(var(--background))]',
        )}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {/* Chevron column. Reserved width even when there are no
            children so every row's icon + title line up horizontally. */}
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); toggleExpanded(page.id); }}
            className="ml-0.5 shrink-0 rounded p-0.5 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        ) : (
          <span className="ml-0.5 inline-block w-[14px] shrink-0" aria-hidden />
        )}
        {editingSlug ? (
          <div className="flex items-center gap-1 px-1 py-1.5">
            <span className="text-[10px] text-[hsl(var(--muted-foreground))]">/</span>
            <input
              ref={slugRef}
              value={slugValue}
              onChange={(e) => setSlugValue(e.target.value)}
              onBlur={commitSlug}
              onKeyDown={(e) => { if (e.key === 'Enter') commitSlug(); if (e.key === 'Escape') setEditingSlug(false); }}
              className="min-w-0 w-20 border-b border-[hsl(var(--primary))] bg-transparent font-mono text-[10px] outline-none"
            />
          </div>
        ) : renaming ? (
          <div className="flex flex-1 items-center gap-1.5 px-1 py-1.5">
            <FileText size={12} className="shrink-0 text-[hsl(var(--status-blue))]" />
            <input
              ref={nameRef}
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') { setRenaming(false); setNameValue(page.title); }
              }}
              onBlur={commitRename}
              className="min-w-0 flex-1 border-b border-[hsl(var(--primary))] bg-transparent text-[11px] outline-none"
            />
          </div>
        ) : (
          <button
            onClick={() => openPage(page)}
            className="flex flex-1 items-center gap-1.5 px-1 py-1.5 pr-2.5 text-[11px]"
          >
            <FileText size={12} className="text-[hsl(var(--status-blue))]" />
            <span className="truncate">{page.title}</span>
          </button>
        )}
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <ConfirmDeleteDialog
          name={page.title}
          kind="page"
          onConfirm={() => { setConfirmDelete(false); void deletePage(page.id); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--popover))] py-1 shadow-xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            onClick={() => { setCtxMenu(null); setEditingSlug(true); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            <Pencil size={12} /> Edit Path
          </button>
          <button
            onClick={() => { setCtxMenu(null); setRenaming(true); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            <Pencil size={12} /> Rename
          </button>
          <button
            onClick={() => { setCtxMenu(null); openPage(page); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            Open
          </button>
          {page.parentId !== null && (
            <button
              onClick={() => { setCtxMenu(null); void updatePage(page.id, { parentId: null }); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
            >
              Move to root
            </button>
          )}
          <div className="my-1 border-t border-[hsl(var(--border))]" />
          <button
            onClick={() => { setCtxMenu(null); setConfirmDelete(true); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))]"
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}

      {/* Children — wrapped in a left-bordered indent so the tree
          structure is visible. Each nesting level adds its own border-l,
          so a node at depth 3 shows 3 stacked guide lines on its left. */}
      {isExpanded && hasChildren && (
        <div className="ml-3 mt-1 flex flex-col gap-1 border-l border-[hsl(var(--border))] pl-2">
          {children.map((child) => (
            <PageTreeItem
              key={child.id}
              page={child}
              pages={pages}
              openPage={openPage}
              deletePage={deletePage}
              depth={depth + 1}
              expandedPages={expandedPages}
              toggleExpanded={toggleExpanded}
              expandPage={expandPage}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Narrative item with inline rename ──

function NarrativeItem({
  graph,
  openGraph,
  deleteGraph,
  updateGraph,
}: {
  graph: import('@/types').Graph;
  openGraph: (g: import('@/types').Graph) => void;
  deleteGraph: (id: string) => Promise<void>;
  updateGraph: (id: string, data: { name: string }) => Promise<void>;
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameValue, setNameValue] = useState(graph.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) inputRef.current.focus();
  }, [renaming]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [ctxMenu]);

  const commitRename = () => {
    setRenaming(false);
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== graph.name) {
      void updateGraph(graph.id, { name: trimmed });
    } else {
      setNameValue(graph.name);
    }
  };

  return (
    <div
      className="group flex w-full items-center rounded-lg border border-[hsl(var(--status-amber))]/30 bg-[hsl(var(--status-amber))]/10 hover:bg-[hsl(var(--status-amber))]/20"
      onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {renaming ? (
        <div className="flex flex-1 items-center gap-1.5 px-2.5 py-1.5">
          <Network size={12} className="shrink-0 text-[hsl(var(--status-amber))]" />
          <input
            ref={inputRef}
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setRenaming(false); setNameValue(graph.name); }
            }}
            onBlur={commitRename}
            className="min-w-0 flex-1 border-b border-[hsl(var(--primary))] bg-transparent text-[11px] outline-none"
          />
        </div>
      ) : (
        <button
          onClick={() => openGraph(graph)}
          className="flex flex-1 items-center gap-1.5 px-2.5 py-1.5 text-[11px]"
        >
          <Network size={12} className="text-[hsl(var(--status-amber))]" />
          <span className="truncate">{graph.name}</span>
        </button>
      )}
      {confirmDelete && (
        <ConfirmDeleteDialog
          name={graph.name}
          kind="attack narrative"
          onConfirm={() => { setConfirmDelete(false); void deleteGraph(graph.id); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {ctxMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--popover))] py-1 shadow-xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            onClick={() => { setCtxMenu(null); setRenaming(true); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            <Pencil size={12} /> Rename
          </button>
          <button
            onClick={() => { setCtxMenu(null); openGraph(graph); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            Open
          </button>
          <div className="my-1 border-t border-[hsl(var(--border))]" />
          <button
            onClick={() => { setCtxMenu(null); setConfirmDelete(true); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))]"
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

function NmapScanItem({
  scan,
  openScan,
  deleteNmapScan,
  renameNmapScan,
}: {
  scan: NmapScan;
  openScan: (s: NmapScan) => void;
  deleteNmapScan: (id: string) => Promise<void>;
  renameNmapScan: (id: string, name: string) => Promise<void>;
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameValue, setNameValue] = useState(scan.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) inputRef.current.focus();
  }, [renaming]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [ctxMenu]);

  const commitRename = () => {
    setRenaming(false);
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== scan.name) {
      void renameNmapScan(scan.id, trimmed);
    } else {
      setNameValue(scan.name);
    }
  };

  return (
    <div className="group flex w-full items-center rounded-lg border border-[hsl(var(--status-green))]/30 bg-[hsl(var(--status-green))]/10 hover:bg-[hsl(var(--status-green))]/20"
      onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {renaming ? (
        <div className="flex flex-1 items-center gap-1.5 px-2.5 py-1.5">
          <Radar size={12} className="shrink-0 text-[hsl(var(--status-green))]" />
          <input
            ref={inputRef}
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setRenaming(false); setNameValue(scan.name); } }}
            className="min-w-0 w-20 border-b border-[hsl(var(--primary))] bg-transparent text-[11px] outline-none"
          />
        </div>
      ) : (
        <button
          onClick={() => openScan(scan)}
          className="flex flex-1 items-center gap-1.5 px-2.5 py-1.5 text-[11px]"
        >
          <Radar size={12} className="text-[hsl(var(--status-green))]" />
          <span className="truncate">{scan.name}</span>
        </button>
      )}

      {confirmDelete && (
        <ConfirmDeleteDialog
          name={scan.name}
          kind="nmap scan"
          onConfirm={() => { setConfirmDelete(false); void deleteNmapScan(scan.id); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {ctxMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--popover))] py-1 shadow-xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            onClick={() => { setCtxMenu(null); setRenaming(true); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            <Pencil size={12} /> Rename
          </button>
          <button
            onClick={() => { setCtxMenu(null); openScan(scan); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            Open
          </button>
          <div className="my-1 border-t border-[hsl(var(--border))]" />
          <button
            onClick={() => { setCtxMenu(null); setConfirmDelete(true); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))]"
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ── Shared confirmation dialog ──

function ConfirmDeleteDialog({
  name,
  kind,
  onConfirm,
  onCancel,
}: {
  name: string;
  kind: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-2 text-sm font-bold">Delete {kind}</h3>
        <p className="mb-4 text-xs text-[hsl(var(--muted-foreground))]">
          Are you sure you want to delete{' '}
          <span className="font-semibold text-[hsl(var(--foreground))]">{name}</span>? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider hover:bg-[hsl(var(--accent))]"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg border border-[hsl(var(--status-red))]/60 bg-[hsl(var(--status-red))]/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--status-red))] hover:bg-[hsl(var(--status-red))]/20"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Attack Chain item with inline rename ──

function AttackChainItem({
  chain,
  graphName,
  openChain,
  highlightChain,
  renameChain,
  deleteChain,
}: {
  chain: AttackChain;
  graphName: string;
  openChain: (c: AttackChain) => void;
  highlightChain: (c: AttackChain) => void;
  renameChain: (id: string, name: string) => Promise<void>;
  deleteChain: (id: string) => Promise<void>;
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameValue, setNameValue] = useState(chain.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) inputRef.current.focus();
  }, [renaming]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [ctxMenu]);

  const commitRename = () => {
    setRenaming(false);
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== chain.name) {
      void renameChain(chain.id, trimmed);
    } else {
      setNameValue(chain.name);
    }
  };

  return (
    <div
      className="group flex w-full items-center rounded-lg border border-[hsl(var(--status-red))]/30 bg-[hsl(var(--status-red))]/10 hover:bg-[hsl(var(--status-red))]/20"
      onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {renaming ? (
        <div className="flex flex-1 items-center gap-1.5 px-2.5 py-1.5">
          <Link2 size={12} className="shrink-0 text-[hsl(var(--status-red))]" />
          <input
            ref={inputRef}
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setRenaming(false); setNameValue(chain.name); }
            }}
            onBlur={commitRename}
            className="min-w-0 flex-1 border-b border-[hsl(var(--primary))] bg-transparent text-[11px] outline-none"
          />
        </div>
      ) : (
        <button
          onClick={() => openChain(chain)}
          className="flex flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px]"
          title={`${chain.nodeIds.length} nodes · in ${graphName}`}
        >
          <Link2 size={12} className="shrink-0 text-[hsl(var(--status-red))]" />
          <span className="truncate">{chain.name}</span>
        </button>
      )}

      {confirmDelete && (
        <ConfirmDeleteDialog
          name={chain.name}
          kind="attack chain"
          onConfirm={() => { setConfirmDelete(false); void deleteChain(chain.id); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {ctxMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--popover))] py-1 shadow-xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            onClick={() => { setCtxMenu(null); openChain(chain); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            Open writeup
          </button>
          <button
            onClick={() => { setCtxMenu(null); highlightChain(chain); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            Highlight on Narrative
          </button>
          <button
            onClick={() => { setCtxMenu(null); setRenaming(true); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            <Pencil size={12} /> Rename
          </button>
          <div className="my-1 border-t border-[hsl(var(--border))]" />
          <button
            onClick={() => { setCtxMenu(null); setConfirmDelete(true); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))]"
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}
