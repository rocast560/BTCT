import { useState, useRef, useEffect, useCallback } from 'react';
import { useAppStore } from '@/stores';
import { useAuthStore } from '@/auth/auth-store';
import { WorkspaceSelector } from '@/components/ui/WorkspaceSelector';
import { AdminPanel } from '@/components/sidebar/AdminPanel';
import { ProfileEditor } from '@/components/sidebar/ProfileEditor';
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
  Clock,
  Link2,
  Shield,
  LogOut,
} from 'lucide-react';
import type { Page, Graph, NmapScan, AttackChain } from '@/types';
import { v4 as uuidv4 } from 'uuid';

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
    setPendingHighlightChainId,
  } = useAppStore();

  const [pagesExpanded, setPagesExpanded] = useState(true);
  const [narrativesExpanded, setNarrativesExpanded] = useState(true);
  const [nmapExpanded, setNmapExpanded] = useState(true);
  const [chainsExpanded, setChainsExpanded] = useState(true);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const authUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const rootPages = pages.filter((p) => p.parentId === null && !p.isGraphPage);

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

  const openChain = (chain: AttackChain) => {
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
    <div className="relative flex h-full flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--card))]" style={{ width: leftSidebarWidth }}>
      {/* Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-[hsl(var(--primary))] active:bg-[hsl(var(--primary))]"
      />
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-widest text-white">Alysa Framework</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={toggleDarkMode} className="p-1 hover:bg-[hsl(var(--accent))]" title="Toggle theme">
            {darkMode ? <Sun size={13} /> : <Moon size={13} />}
          </button>
          <button onClick={toggleLeftSidebar} className="p-1 hover:bg-[hsl(var(--accent))]" title="Close sidebar">
            <PanelLeftClose size={13} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1">
          <Search size={14} className="text-[hsl(var(--muted-foreground))]" />
          <input
            type="text"
            placeholder="Search pages..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[hsl(var(--muted-foreground))]"
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
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-[hsl(var(--accent))]"
            >
              <FileText size={12} className="text-blue-400" />
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
          <div className="flex w-full items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2">
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
                className="flex w-full items-center gap-1.5 border border-red-600/40 bg-red-500/10 px-2 py-1 text-left text-[11px] hover:bg-red-500/20"
              >
                <Bug size={12} className="text-red-400" />
                <span className="truncate">Findings</span>
              </button>
              <button
                onClick={openTimeline}
                className="flex w-full items-center gap-1.5 border border-orange-600/40 bg-orange-500/10 px-2 py-1 text-left text-[11px] hover:bg-orange-500/20"
              >
                <Clock size={12} className="text-orange-400" />
                <span className="truncate">Attack Timeline</span>
              </button>
              {rootPages.map((page) => (
                <PageTreeItem key={page.id} page={page} pages={pages} openPage={openPage} deletePage={deletePage} depth={0} />
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
                <div className="flex w-full items-center gap-1 border border-teal-600/40 bg-teal-500/10 px-2 py-1">
                  <Radar size={12} className="shrink-0 text-teal-400" />
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
              {nmapScans.map((scan) => (
                <NmapScanItem key={scan.id} scan={scan} openScan={openScan} deleteNmapScan={deleteNmapScan} renameNmapScan={renameNmapScan} />
              ))}
              {nmapScans.length === 0 && !creatingGroup && (
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
          <div className="flex items-center gap-2.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 py-2">
            <button
              onClick={() => setProfileEditorOpen(true)}
              title="Edit profile"
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
            >
              {authUser.avatar ? (
                <img
                  src={authUser.avatar}
                  alt=""
                  className="h-9 w-9 shrink-0 rounded-full object-cover"
                  style={{ boxShadow: `0 0 0 2px ${authUser.color}` }}
                />
              ) : (
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
                  style={{ backgroundColor: authUser.color }}
                  aria-hidden="true"
                >
                  {authUser.username.charAt(0).toUpperCase()}
                </span>
              )}
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
          <button
            onClick={() => setAdminPanelOpen(true)}
            className="flex items-center justify-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/20"
          >
            <Shield size={12} />
            <span>Admin Panel</span>
          </button>
        )}
      </div>

      {adminPanelOpen && <AdminPanel onClose={() => setAdminPanelOpen(false)} />}
      {profileEditorOpen && <ProfileEditor onClose={() => setProfileEditorOpen(false)} />}
    </div>
  );
}

function PageTreeItem({
  page,
  pages,
  openPage,
  deletePage,
  depth,
}: {
  page: Page;
  pages: Page[];
  openPage: (p: Page) => void;
  deletePage: (id: string) => Promise<void>;
  depth: number;
}) {
  const [expanded] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [editingSlug, setEditingSlug] = useState(false);
  const [slugValue, setSlugValue] = useState(page.slug ?? '');
  const [renaming, setRenaming] = useState(false);
  const [nameValue, setNameValue] = useState(page.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const updatePage = useAppStore((s) => s.updatePage);
  const slugRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const children = pages.filter((p) => p.parentId === page.id);

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
        className="flex w-full items-center border border-blue-600/40 bg-blue-500/10 hover:bg-blue-500/20"
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {editingSlug ? (
          <div className="flex items-center gap-1 px-2 py-1">
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
          <div className="flex flex-1 items-center gap-1.5 px-2 py-1">
            <FileText size={12} className="shrink-0 text-blue-400" />
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
            className="flex flex-1 items-center gap-1.5 px-2 py-1 text-[11px]"
          >
            <FileText size={12} className="text-blue-400" />
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
          className="fixed z-50 min-w-[140px] border border-[hsl(var(--border))] bg-[hsl(var(--popover))] py-1 shadow-xl"
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
          <div className="my-1 border-t border-[hsl(var(--border))]" />
          <button
            onClick={() => { setCtxMenu(null); setConfirmDelete(true); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))]"
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}

      {expanded &&
        children.map((child) => (
          <PageTreeItem key={child.id} page={child} pages={pages} openPage={openPage} deletePage={deletePage} depth={depth + 1} />
        ))}
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
      className="group flex w-full items-center border border-amber-600/40 bg-amber-500/10 hover:bg-amber-500/20"
      onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {renaming ? (
        <div className="flex flex-1 items-center gap-1.5 px-2 py-1">
          <Network size={12} className="shrink-0 text-amber-400" />
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
          className="flex flex-1 items-center gap-1.5 px-2 py-1 text-[11px]"
        >
          <Network size={12} className="text-amber-400" />
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
          className="fixed z-50 min-w-[140px] border border-[hsl(var(--border))] bg-[hsl(var(--popover))] py-1 shadow-xl"
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
    <div className="group flex w-full items-center border border-teal-600/40 bg-teal-500/10 hover:bg-teal-500/20"
      onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {renaming ? (
        <div className="flex flex-1 items-center gap-1.5 px-2 py-1">
          <Radar size={12} className="shrink-0 text-teal-400" />
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
          className="flex flex-1 items-center gap-1.5 px-2 py-1 text-[11px]"
        >
          <Radar size={12} className="text-teal-400" />
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
          className="fixed z-50 min-w-[140px] border border-[hsl(var(--border))] bg-[hsl(var(--popover))] py-1 shadow-xl"
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
      <div className="w-full max-w-sm border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-2 text-sm font-bold">Delete {kind}</h3>
        <p className="mb-4 text-xs text-[hsl(var(--muted-foreground))]">
          Are you sure you want to delete{' '}
          <span className="font-semibold text-[hsl(var(--foreground))]">{name}</span>? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="border border-[hsl(var(--border))] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider hover:bg-[hsl(var(--accent))]"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="border border-red-500 bg-red-500/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-red-400 hover:bg-red-500/20"
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
  renameChain,
  deleteChain,
}: {
  chain: AttackChain;
  graphName: string;
  openChain: (c: AttackChain) => void;
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
      className="group flex w-full flex-col border border-red-600/40 bg-red-500/10 hover:bg-red-500/20"
      onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {renaming ? (
        <div className="flex flex-1 items-center gap-1.5 px-2 py-1">
          <Link2 size={12} className="shrink-0 text-red-400" />
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
          className="flex flex-1 items-start gap-1.5 px-2 py-1 text-left text-[11px]"
          title={`${chain.nodeIds.length} nodes · in ${graphName}`}
        >
          <Link2 size={12} className="mt-0.5 shrink-0 text-red-400" />
          <div className="min-w-0 flex-1">
            <div className="truncate">{chain.name}</div>
            <div className="truncate text-[9px] text-[hsl(var(--muted-foreground))]">
              {chain.nodeIds.length} nodes · {graphName}
            </div>
          </div>
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
          className="fixed z-50 min-w-[160px] border border-[hsl(var(--border))] bg-[hsl(var(--popover))] py-1 shadow-xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            onClick={() => { setCtxMenu(null); openChain(chain); }}
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
