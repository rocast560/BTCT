import { create } from 'zustand';
import type { Workspace, Page, Graph, GraphNode, GraphEdge, TabItem, ID, ChangeLogEntry, NmapScan, NmapMachine, PaneNode, DropPosition, AttackChain, TypstAsset, TypstAssetKind, CropRect, BlurRegion, CommandLogEntry } from '@/types';
import { sharedTransact } from '@/realtime/shared-doc';
import { workspaceRepo, pageRepo, graphRepo, graphNodeRepo, graphEdgeRepo, changeLogRepo, nmapScanRepo, nmapMachineRepo, attackChainRepo, typstAssetRepo, commandLogRepo } from '@/db';
import type { LogAuthor, LogDelta } from '@/db/changelog-repo';
import { db } from '@/db/database';
import { useAuthStore } from '@/auth/auth-store';
import { createLeaf, findLeafContainingTab, firstLeaf, addTabToPane, removeTab as removeTabFromLayout, collapse, moveTab, removeTabsWhere, setActiveInPane, updateRatio } from '@/lib/pane-layout';

// ─────────────────────────────────────────────────────────────────────────
// UI persistence: keep tabs / active tab / pane layout / active workspace
// across page refreshes so the user lands back on the page they left off.
// Stored as a single JSON blob in localStorage.
// ─────────────────────────────────────────────────────────────────────────
const UI_PERSIST_KEY = 'btct.ui.v1';

interface PersistedUi {
  activeWorkspaceId: ID | null;
  tabs: TabItem[];
  activeTabId: string | null;
  paneLayout: PaneNode;
  activePaneId: string | null;
}

function loadPersistedUi(): Partial<PersistedUi> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(UI_PERSIST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedUi>;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function savePersistedUi(snapshot: PersistedUi): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(UI_PERSIST_KEY, JSON.stringify(snapshot));
  } catch {
    /* quota / serialization errors: non-fatal */
  }
}

const persistedUi = loadPersistedUi();

interface AppState {
  // Workspace
  workspaces: Workspace[];
  activeWorkspaceId: ID | null;
  loadWorkspaces: () => Promise<void>;
  setActiveWorkspace: (id: ID) => void;
  createWorkspace: (name: string, description: string) => Promise<Workspace>;
  deleteWorkspace: (id: ID) => Promise<void>;

  // Pages
  pages: Page[];
  loadPages: () => Promise<void>;
  createPage: (parentId: ID | null, title: string) => Promise<Page>;
  updatePage: (id: ID, data: Partial<Omit<Page, 'id' | 'workspaceId' | 'createdAt'>>) => Promise<void>;
  deletePage: (id: ID) => Promise<void>;

  // Graphs (Attack Narratives)
  graphs: Graph[];
  loadGraphs: () => Promise<void>;
  createGraph: (name: string) => Promise<Graph>;
  updateGraph: (id: ID, data: Partial<Pick<Graph, 'name'>>) => Promise<void>;
  deleteGraph: (id: ID) => Promise<void>;

  // Graph nodes
  graphNodes: GraphNode[];
  loadGraphData: (graphId: ID) => Promise<void>;
  addGraphNode: (graphId: ID, type: GraphNode['type'], label: string, position: { x: number; y: number }) => Promise<GraphNode>;
  updateGraphNode: (id: ID, data: Partial<Omit<GraphNode, 'id' | 'graphId' | 'createdAt'>>) => Promise<void>;
  /** Batch position writes: one Yjs transaction, one store update. */
  updateGraphNodePositions: (updates: Array<{ id: ID; position: { x: number; y: number } }>) => Promise<void>;
  deleteGraphNode: (id: ID) => Promise<void>;

  // Graph edges
  graphEdges: GraphEdge[];
  addGraphEdge: (graphId: ID, sourceNodeId: ID, targetNodeId: ID, edgeType: GraphEdge['edgeType']) => Promise<GraphEdge>;
  updateGraphEdge: (id: ID, data: Partial<Omit<GraphEdge, 'id' | 'graphId' | 'createdAt'>>) => Promise<void>;
  deleteGraphEdge: (id: ID) => Promise<void>;

  // Tabs
  tabs: TabItem[];
  activeTabId: string | null;
  openTab: (tab: TabItem) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;

  // Split panes
  paneLayout: PaneNode;
  activePaneId: string | null;
  setActivePane: (paneId: string) => void;
  moveTabToPane: (tabId: string, targetPaneId: string, position: DropPosition) => void;
  updateSplitRatio: (splitId: string, ratio: number) => void;
  /**
   * Collapse every split pane into a single pane holding all current tabs
   * (the "take over everything" follow layout). Tabs are preserved; only the
   * split structure is removed. `activeTabId`, when given, becomes active.
   */
  mergePanesIntoOne: (activeTabId?: string | null) => void;

  // Live presence / follow (ephemeral: not persisted)
  followPanelOpen: boolean;
  setFollowPanelOpen: (open: boolean) => void;
  /** User id of the teammate currently being followed, or null. */
  followingUserId: number | null;
  setFollowingUserId: (userId: number | null) => void;
  /** Currently-inspected nmap host id (broadcast for followers). */
  selectedNmapMachineId: ID | null;
  setSelectedNmapMachineId: (id: ID | null) => void;

  // UI
  leftSidebarOpen: boolean;
  leftSidebarWidth: number;
  setLeftSidebarWidth: (width: number) => void;
  rightSidebarOpen: boolean;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  darkMode: boolean;
  toggleDarkMode: () => void;
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  // Selection (for right sidebar properties)
  selectedNodeId: ID | null;
  selectedEdgeId: ID | null;
  setSelectedNode: (id: ID | null) => void;
  setSelectedEdge: (id: ID | null) => void;

  // Search
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchResults: Page[];
  runSearch: () => Promise<void>;

  // Change log
  changeLogs: ChangeLogEntry[];
  loadChangeLogs: () => Promise<void>;
  /**
   * Re-apply the prevValue of an `update` log entry, or recreate the
   * entity from the captured snapshot of a `delete` entry. Returns true
   * if the restore was applied; false if the entry is not reversible
   * or its target is no longer addressable. Always records a new
   * `restore` action entry for audit.
   */
  restoreFromLog: (entryId: ID) => Promise<boolean>;

  // Nmap scans
  nmapScans: NmapScan[];
  nmapMachines: NmapMachine[];
  loadNmapScans: () => Promise<void>;
  createNmapGroup: (name: string) => Promise<NmapScan>;
  importToNmapGroup: (groupId: ID, xml: string) => Promise<void>;
  importNmapScan: (name: string, xml: string) => Promise<NmapScan>;
  renameNmapScan: (id: ID, name: string) => Promise<void>;
  deleteNmapScan: (id: ID) => Promise<void>;
  loadNmapMachines: (scanId: ID) => Promise<void>;
  updateNmapMachine: (id: ID, data: Partial<Pick<NmapMachine, 'hostname' | 'os'>>) => Promise<void>;
  deleteNmapMachine: (id: ID) => Promise<void>;
  linkMachineToNode: (machineId: ID, nodeId: ID) => Promise<void>;
  unlinkMachine: (machineId: ID) => Promise<void>;
  toggleMachinePort: (machineId: ID, port: number, enabled: boolean) => void;

  // Navigation
  pendingFocusNodeId: string | null;
  setPendingFocusNodeId: (nodeId: string | null) => void;

  // Attack Chains
  attackChains: AttackChain[];
  loadAttackChains: () => Promise<void>;
  createAttackChain: (graphId: ID, name: string, nodeIds: ID[]) => Promise<AttackChain>;
  updateAttackChain: (id: ID, data: Partial<Pick<AttackChain, 'name' | 'nodeIds'>>) => Promise<void>;
  deleteAttackChain: (id: ID) => Promise<void>;
  addNodesToAttackChain: (id: ID, nodeIds: ID[]) => Promise<void>;
  ensureAttackChainPage: (id: ID) => Promise<ID | null>;
  pendingHighlightChainId: ID | null;
  setPendingHighlightChainId: (id: ID | null) => void;

  // Typst assets (report screenshots + custom fonts)
  typstAssets: TypstAsset[];
  loadTypstAssets: () => Promise<void>;
  addTypstAsset: (file: File, kind: TypstAssetKind) => Promise<TypstAsset>;
  setTypstAssetCrop: (id: ID, crop: CropRect | null, blurs?: BlurRegion[] | null) => Promise<void>;
  /** Rename an asset's file stem. Returns the resulting filename. */
  renameTypstAsset: (id: ID, stem: string) => Promise<string>;
  deleteTypstAsset: (id: ID) => Promise<void>;

  // Command log (team pentest command activity: ingested server-side, read-only here)
  commandLogs: CommandLogEntry[];
  loadCommandLogs: () => Promise<void>;

  // Database
  deleteDatabase: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => {
  const currentAuthor = (): LogAuthor => {
    const u = useAuthStore.getState().user;
    if (!u) return { userId: null, userName: null, userColor: null };
    return { userId: u.id, userName: u.username, userColor: u.color };
  };
  const log = (
    action: ChangeLogEntry['action'],
    target: ChangeLogEntry['target'],
    targetId: string,
    summary: string,
    delta: LogDelta = {},
  ) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    void changeLogRepo.add(wsId, action, target, targetId, summary, currentAuthor(), delta).then((entry) => {
      set((s) => ({ changeLogs: [entry, ...s.changeLogs].slice(0, 200) }));
    });
  };
  // Stringify any JSON-serialisable value so prev/new round-trip safely
  // through the log entry. Returns null for nullish so the DB column
  // stays sparse rather than holding the string "null".
  const encodeValue = (v: unknown): string | null =>
    v === null || v === undefined ? null : JSON.stringify(v);
  const decodeValue = <T = unknown>(s: string | null | undefined): T | null =>
    s == null ? null : (JSON.parse(s) as T);

  return ({
  // Workspace
  workspaces: [],
  activeWorkspaceId: persistedUi.activeWorkspaceId ?? null,

  loadWorkspaces: async () => {
    const workspaces = await workspaceRepo.getAll();
    set({ workspaces });
    // Validate the (possibly persisted) active workspace still exists.
    const current = get().activeWorkspaceId;
    const stillValid = current ? workspaces.some((w) => w.id === current) : false;
    if (!stillValid) {
      // Persisted workspace is gone: clear stale tabs/pane layout that
      // referenced it so we don't render dead tabs from a deleted workspace.
      const first = workspaces[0];
      set({
        activeWorkspaceId: first ? first.id : null,
        tabs: [],
        activeTabId: null,
        paneLayout: createLeaf(),
        activePaneId: null,
      });
    }
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id, tabs: [], activeTabId: null, paneLayout: createLeaf(), activePaneId: null, pages: [], graphs: [], graphNodes: [], graphEdges: [], attackChains: [], nmapScans: [], nmapMachines: [], typstAssets: [], commandLogs: [] });
    // Reload workspace-scoped lists for the newly-active workspace so stale
    // entries from the previous workspace don't appear before the per-view
    // useEffects fire (and so newly-created scans never inherit the prior
    // workspace's list in state).
    void get().loadNmapScans();
    void get().loadTypstAssets();
    void get().loadCommandLogs();
  },

  createWorkspace: async (name, description) => {
    const ws = await workspaceRepo.create({ name, description });
    set((s) => ({ workspaces: [...s.workspaces, ws] }));
    return ws;
  },

  deleteWorkspace: async (id) => {
    await workspaceRepo.remove(id);
    const wasActive = get().activeWorkspaceId === id;
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== id),
      activeWorkspaceId: wasActive ? null : s.activeWorkspaceId,
      ...(wasActive ? {
        pages: [],
        graphs: [],
        graphNodes: [],
        graphEdges: [],
        nmapScans: [],
        nmapMachines: [],
        attackChains: [],
        tabs: [],
        activeTabId: null,
        paneLayout: createLeaf(),
        activePaneId: null,
        selectedNodeId: null,
        selectedEdgeId: null,
      } : {}),
    }));
  },

  // Pages
  pages: [],

  loadPages: async () => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    const pages = await pageRepo.getByWorkspace(wsId);
    set({ pages });
  },

  createPage: async (parentId, title) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) throw new Error('No active workspace');
    const page = await pageRepo.create({ workspaceId: wsId, parentId, title });
    set((s) => ({ pages: [...s.pages, page] }));
    log('create', 'page', page.id, `Created page "${title}"`);
    return page;
  },

  updatePage: async (id, data) => {
    const prev = get().pages.find((p) => p.id === id);
    await pageRepo.update(id, data);
    set((s) => ({
      pages: s.pages.map((p) => (p.id === id ? { ...p, ...data, updatedAt: Date.now() } : p)),
    }));
    if (data.title && prev && prev.title !== data.title) {
      log('update', 'page', id, `Renamed page "${prev.title}" → "${data.title}"`, {
        field: 'title',
        prevValue: encodeValue(prev.title),
        newValue: encodeValue(data.title),
        reversible: true,
      });
    } else if (data.content) {
      // Page bodies are persisted via Yjs per-page docs; per-keystroke
      // change-log entries would be noisy. Page snapshots (see Page
      // History panel) provide rollback for body content instead.
      // Coalesced: an editing session logs one entry per page per minute.
      // Without this, every debounced save appends to the shared changeLogs
      // table (which is never pruned) and re-sorts it on every append.
      const last = get().changeLogs[0];
      const coalesced = !!last
        && last.action === 'update'
        && last.target === 'page'
        && last.targetId === id
        && last.summary === 'Updated page content'
        && Date.now() - last.timestamp < 60_000;
      if (!coalesced) log('update', 'page', id, 'Updated page content');
    }
  },

  deletePage: async (id) => {
    const page = get().pages.find((p) => p.id === id);
    await pageRepo.remove(id);
    set((s) => ({
      pages: s.pages.filter((p) => p.id !== id),
      tabs: s.tabs.filter((t) => !(t.kind === 'page' && t.entityId === id)),
      paneLayout: collapse(removeTabsWhere(s.paneLayout, (tid) => {
        const tab = s.tabs.find((t) => t.id === tid);
        return !!tab && tab.kind === 'page' && tab.entityId === id;
      })),
    }));
    log('delete', 'page', id, `Deleted page "${page?.title ?? id}"`, {
      prevValue: encodeValue(page),
      reversible: !!page,
    });
  },

  // Graphs
  graphs: [],

  loadGraphs: async () => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    const graphs = await graphRepo.getByWorkspace(wsId);
    set({ graphs });
  },

  createGraph: async (name) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) throw new Error('No active workspace');
    const graph = await graphRepo.create({ workspaceId: wsId, name });
    set((s) => ({ graphs: [...s.graphs, graph] }));
    log('create', 'graph', graph.id, `Created narrative "${name}"`);
    return graph;
  },

  updateGraph: async (id, data) => {
    const prev = get().graphs.find((g) => g.id === id);
    await graphRepo.update(id, data);
    set((s) => ({
      graphs: s.graphs.map((g) => (g.id === id ? { ...g, ...data, updatedAt: Date.now() } : g)),
    }));
    if (data.name && prev && prev.name !== data.name) {
      log('update', 'graph', id, `Renamed narrative "${prev.name}" → "${data.name}"`, {
        field: 'name',
        prevValue: encodeValue(prev.name),
        newValue: encodeValue(data.name),
        reversible: true,
      });
    }
  },

  deleteGraph: async (id) => {
    const graph = get().graphs.find((g) => g.id === id);
    await graphRepo.remove(id);
    // Cascade: delete any attack chains scoped to this graph
    const chainsToDelete = get().attackChains.filter((c) => c.graphId === id);
    for (const c of chainsToDelete) {
      await attackChainRepo.remove(c.id);
    }
    set((s) => ({
      graphs: s.graphs.filter((g) => g.id !== id),
      attackChains: s.attackChains.filter((c) => c.graphId !== id),
      tabs: s.tabs.filter((t) => !(t.kind === 'graph' && t.entityId === id)),
      paneLayout: collapse(removeTabsWhere(s.paneLayout, (tid) => {
        const tab = s.tabs.find((t) => t.id === tid);
        return !!tab && tab.kind === 'graph' && tab.entityId === id;
      })),
    }));
    log('delete', 'graph', id, `Deleted narrative "${graph?.name ?? id}"`);
  },

  // Graph nodes
  graphNodes: [],

  loadGraphData: async (graphId) => {
    const [nodes, edges] = await Promise.all([
      graphNodeRepo.getByGraph(graphId),
      graphEdgeRepo.getByGraph(graphId),
    ]);
    // Merge per-graph: keep nodes/edges belonging to OTHER graphs, replace
    // the slice for this graphId. Replacing the whole array races with
    // concurrent loadGraphData() calls for other open graph tabs (and
    // with optimistic in-flight updates), which manifested as nodes
    // briefly disappearing when dropping after a drag.
    set((s) => ({
      graphNodes: [...s.graphNodes.filter((n) => n.graphId !== graphId), ...nodes],
      graphEdges: [...s.graphEdges.filter((e) => e.graphId !== graphId), ...edges],
    }));
  },

  addGraphNode: async (graphId, type, label, position) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) throw new Error('No active workspace');
    const node = await graphNodeRepo.create({ graphId, type, label, position, workspaceId: wsId });
    set((s) => ({ graphNodes: [...s.graphNodes, node] }));
    log('create', 'node', node.id, `Added ${type} node "${label}"`);
    return node;
  },

  updateGraphNode: async (id, data) => {
    const prev = get().graphNodes.find((n) => n.id === id);
    await graphNodeRepo.update(id, data);
    set((s) => ({
      graphNodes: s.graphNodes.map((n) => (n.id === id ? { ...n, ...data, updatedAt: Date.now() } : n)),
    }));
    if (data.label && prev && prev.label !== data.label) {
      log('update', 'node', id, `Renamed node "${prev.label}" → "${data.label}"`, {
        field: 'label',
        prevValue: encodeValue(prev.label),
        newValue: encodeValue(data.label),
        reversible: true,
      });
    }
    // If host node hostname changed, sync to linked nmap machine
    if (data.data && 'hostname' in data.data) {
      const newHostname = (data.data as import('@/types').HostData).hostname;
      const linkedMachine = get().nmapMachines.find((m) => m.linkedNodeId === id);
      if (linkedMachine && linkedMachine.hostname !== newHostname) {
        await nmapMachineRepo.update(linkedMachine.id, { hostname: newHostname });
        set((s) => ({
          nmapMachines: s.nmapMachines.map((m) => m.id === linkedMachine.id ? { ...m, hostname: newHostname, updatedAt: Date.now() } : m),
        }));
      }
    }
  },

  updateGraphNodePositions: async (updates) => {
    if (updates.length === 0) return;
    // One Yjs transaction: peers receive a single update message for the
    // whole layout instead of one per node (repo.update writes
    // synchronously, so the nested transactions merge into this one).
    sharedTransact(() => {
      for (const u of updates) void graphNodeRepo.update(u.id, { position: u.position });
    });
    const now = Date.now();
    const byId = new Map(updates.map((u) => [u.id, u.position]));
    set((s) => ({
      graphNodes: s.graphNodes.map((n) => {
        const p = byId.get(n.id);
        return p ? { ...n, position: p, updatedAt: now } : n;
      }),
    }));
  },

  deleteGraphNode: async (id) => {
    const node = get().graphNodes.find((n) => n.id === id);
    // Unlink any nmap machines connected to this node
    await nmapMachineRepo.unlinkByNode(id);
    await graphNodeRepo.remove(id);
    // Remove this node id from any attack chains that reference it
    const affectedChains = get().attackChains.filter((c) => c.nodeIds.includes(id));
    for (const c of affectedChains) {
      const next = c.nodeIds.filter((nid) => nid !== id);
      await attackChainRepo.update(c.id, { nodeIds: next });
    }
    set((s) => ({
      graphNodes: s.graphNodes.filter((n) => n.id !== id),
      graphEdges: s.graphEdges.filter((e) => e.sourceNodeId !== id && e.targetNodeId !== id),
      nmapMachines: s.nmapMachines.map((m) => m.linkedNodeId === id ? { ...m, linkedNodeId: undefined } : m),
      attackChains: s.attackChains.map((c) => c.nodeIds.includes(id) ? { ...c, nodeIds: c.nodeIds.filter((nid) => nid !== id), updatedAt: Date.now() } : c),
      selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
    }));
    log('delete', 'node', id, `Deleted node "${node?.label ?? id}"`, {
      prevValue: encodeValue(node),
      reversible: !!node,
    });
  },

  // Graph edges
  graphEdges: [],

  addGraphEdge: async (graphId, sourceNodeId, targetNodeId, edgeType) => {
    const edge = await graphEdgeRepo.create({ graphId, sourceNodeId, targetNodeId, edgeType });
    set((s) => ({ graphEdges: [...s.graphEdges, edge] }));
    log('create', 'edge', edge.id, `Added ${edgeType} edge`);
    return edge;
  },

  updateGraphEdge: async (id, data) => {
    const prev = get().graphEdges.find((e) => e.id === id);
    await graphEdgeRepo.update(id, data);
    set((s) => ({
      graphEdges: s.graphEdges.map((e) => (e.id === id ? { ...e, ...data, updatedAt: Date.now() } : e)),
    }));
    if (data.label !== undefined && prev && prev.label !== data.label) {
      log('update', 'edge', id, `Edge label "${prev.label ?? ''}" → "${data.label}"`, {
        field: 'label',
        prevValue: encodeValue(prev.label),
        newValue: encodeValue(data.label),
        reversible: true,
      });
    }
  },

  deleteGraphEdge: async (id) => {
    const edge = get().graphEdges.find((e) => e.id === id);
    await graphEdgeRepo.remove(id);
    set((s) => ({
      graphEdges: s.graphEdges.filter((e) => e.id !== id),
      selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
    }));
    log('delete', 'edge', id, 'Deleted edge', {
      prevValue: encodeValue(edge),
      reversible: !!edge,
    });
  },

  // Tabs & Panes
  tabs: persistedUi.tabs ?? [],
  activeTabId: persistedUi.activeTabId ?? null,
  paneLayout: persistedUi.paneLayout ?? createLeaf(),
  activePaneId: persistedUi.activePaneId ?? null,

  openTab: (tab) => {
    set((s) => {
      // Deduplicate: if a tab with same kind+entityId exists, just activate it in its pane
      const existing = s.tabs.find((t) => t.kind === tab.kind && t.entityId === tab.entityId);
      if (existing) {
        const leaf = findLeafContainingTab(s.paneLayout, existing.id);
        if (leaf) {
          return {
            activeTabId: existing.id,
            activePaneId: leaf.id,
            paneLayout: setActiveInPane(s.paneLayout, leaf.id, existing.id),
          };
        }
        return { activeTabId: existing.id };
      }
      // Add to active pane (or first leaf)
      const targetPaneId = s.activePaneId ?? firstLeaf(s.paneLayout).id;
      return {
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        activePaneId: targetPaneId,
        paneLayout: addTabToPane(s.paneLayout, targetPaneId, tab.id),
      };
    });
  },

  closeTab: (tabId) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tabId);
      const newTabs = s.tabs.filter((t) => t.id !== tabId);
      // Remove from pane layout and collapse empty panes
      let newLayout = removeTabFromLayout(s.paneLayout, tabId);
      newLayout = collapse(newLayout);
      // Figure out new active tab
      const leaf = findLeafContainingTab(s.paneLayout, tabId);
      let newActive = s.activeTabId;
      let newActivePane = s.activePaneId;
      if (s.activeTabId === tabId) {
        // Try to activate sibling in same pane
        if (leaf) {
          const remaining = leaf.tabIds.filter((id) => id !== tabId);
          const prevIdx = Math.max(0, leaf.tabIds.indexOf(tabId) - 1);
          newActive = remaining[Math.min(prevIdx, remaining.length - 1)] ?? null;
        } else {
          const prev = newTabs[Math.max(0, idx - 1)];
          newActive = prev?.id ?? null;
        }
        if (newActive) {
          const newLeaf = findLeafContainingTab(newLayout, newActive);
          newActivePane = newLeaf?.id ?? firstLeaf(newLayout).id;
        } else {
          newActivePane = firstLeaf(newLayout).id;
        }
      }
      return { tabs: newTabs, activeTabId: newActive, paneLayout: newLayout, activePaneId: newActivePane };
    });
  },

  setActiveTab: (tabId) => {
    set((s) => {
      const leaf = findLeafContainingTab(s.paneLayout, tabId);
      if (leaf) {
        return {
          activeTabId: tabId,
          activePaneId: leaf.id,
          paneLayout: setActiveInPane(s.paneLayout, leaf.id, tabId),
        };
      }
      return { activeTabId: tabId };
    });
  },

  setActivePane: (paneId) => {
    set((s) => {
      const leaf = (() => {
        const find = (n: PaneNode): PaneNode | null => {
          if (n.type === 'leaf') return n.id === paneId ? n : null;
          return find(n.children[0]) ?? find(n.children[1]);
        };
        return find(s.paneLayout);
      })();
      if (leaf && leaf.type === 'leaf') {
        return { activePaneId: paneId, activeTabId: leaf.activeTabId ?? s.activeTabId };
      }
      return { activePaneId: paneId };
    });
  },

  moveTabToPane: (tabId, targetPaneId, position) => {
    set((s) => {
      const newLayout = moveTab(s.paneLayout, tabId, targetPaneId, position);
      // Find where the tab ended up
      const newLeaf = findLeafContainingTab(newLayout, tabId);
      return {
        paneLayout: newLayout,
        activeTabId: tabId,
        activePaneId: newLeaf?.id ?? s.activePaneId,
      };
    });
  },

  updateSplitRatio: (splitId, ratio) => {
    set((s) => ({ paneLayout: updateRatio(s.paneLayout, splitId, ratio) }));
  },

  mergePanesIntoOne: (activeTabId) => {
    set((s) => {
      const nextActive = activeTabId ?? s.activeTabId;
      const leaf = createLeaf(s.tabs.map((t) => t.id), nextActive);
      return { paneLayout: leaf, activePaneId: leaf.id, activeTabId: nextActive };
    });
  },

  followPanelOpen: false,
  setFollowPanelOpen: (open) => set({ followPanelOpen: open }),
  followingUserId: null,
  setFollowingUserId: (userId) => set({ followingUserId: userId }),
  selectedNmapMachineId: null,
  setSelectedNmapMachineId: (id) => set({ selectedNmapMachineId: id }),

  // UI
  leftSidebarOpen: true,
  leftSidebarWidth: 280,
  setLeftSidebarWidth: (width: number) => set({ leftSidebarWidth: Math.min(480, Math.max(200, width)) }),
  rightSidebarOpen: true,
  toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
  toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
  darkMode: true,
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      document.documentElement.classList.toggle('dark', next);
      return { darkMode: next };
    }),
  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

  // Selection
  selectedNodeId: null,
  selectedEdgeId: null,
  setSelectedNode: (id) => set({ selectedNodeId: id, selectedEdgeId: null }),
  setSelectedEdge: (id) => set({ selectedEdgeId: id, selectedNodeId: null }),

  // Search
  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),
  searchResults: [],
  runSearch: async () => {
    const { searchQuery, activeWorkspaceId } = get();
    if (!activeWorkspaceId || !searchQuery.trim()) {
      set({ searchResults: [] });
      return;
    }
    const results = await pageRepo.search(activeWorkspaceId, searchQuery);
    set({ searchResults: results });
  },

  // Change log
  changeLogs: [],
  loadChangeLogs: async () => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    const logs = await changeLogRepo.getByWorkspace(wsId);
    set({ changeLogs: logs });
  },

  restoreFromLog: async (entryId: ID) => {
    const entry = get().changeLogs.find((e) => e.id === entryId);
    if (!entry || !entry.reversible) return false;

    if (entry.action === 'update' && entry.field) {
      const value = decodeValue<unknown>(entry.prevValue);
      switch (entry.target) {
        case 'page':
          await get().updatePage(entry.targetId, { [entry.field]: value } as Partial<Page>);
          break;
        case 'graph':
          await get().updateGraph(entry.targetId, { [entry.field]: value } as Partial<Pick<Graph, 'name'>>);
          break;
        case 'node':
          await get().updateGraphNode(entry.targetId, { [entry.field]: value } as Partial<GraphNode>);
          break;
        case 'edge':
          await get().updateGraphEdge(entry.targetId, { [entry.field]: value } as Partial<GraphEdge>);
          break;
        case 'attackChain':
          await get().updateAttackChain(entry.targetId, { [entry.field]: value } as Partial<Pick<AttackChain, 'name' | 'nodeIds'>>);
          break;
        default:
          return false;
      }
      log('restore', entry.target, entry.targetId,
          `Restored ${entry.field} to previous value`);
      return true;
    }

    if (entry.action === 'delete') {
      const prev = decodeValue<Record<string, unknown>>(entry.prevValue);
      if (!prev || typeof prev !== 'object') return false;
      try {
        // Recreate via the same Y.Map the original entity lived in. We
        // reuse the original id so any references (graph nodes pointing
        // at this page, attack chains referencing this node, etc.) keep
        // resolving. Cast via `unknown` because the stored JSON is opaque
        // to the type system but the runtime shape matches the entity.
        switch (entry.target) {
          case 'page': {
            const rec = prev as unknown as Page;
            await db.pages.add(rec);
            set((s) => ({ pages: [...s.pages.filter((p) => p.id !== entry.targetId), rec] }));
            break;
          }
          case 'graph': {
            const rec = prev as unknown as Graph;
            await db.graphs.add(rec);
            set((s) => ({ graphs: [...s.graphs.filter((g) => g.id !== entry.targetId), rec] }));
            break;
          }
          case 'node': {
            const rec = prev as unknown as GraphNode;
            await db.graphNodes.add(rec);
            set((s) => ({ graphNodes: [...s.graphNodes.filter((n) => n.id !== entry.targetId), rec] }));
            break;
          }
          case 'edge': {
            const rec = prev as unknown as GraphEdge;
            await db.graphEdges.add(rec);
            set((s) => ({ graphEdges: [...s.graphEdges.filter((e) => e.id !== entry.targetId), rec] }));
            break;
          }
          case 'attackChain': {
            const rec = prev as unknown as AttackChain;
            await db.attackChains.add(rec);
            set((s) => ({ attackChains: [...s.attackChains.filter((c) => c.id !== entry.targetId), rec] }));
            break;
          }
          default:
            return false;
        }
        log('restore', entry.target, entry.targetId,
            `Restored deleted ${entry.target} "${(prev['name'] ?? prev['title'] ?? prev['label'] ?? entry.targetId) as string}"`);
        return true;
      } catch {
        return false;
      }
    }

    return false;
  },

  // Nmap scans
  nmapScans: [],
  nmapMachines: [],
  loadNmapScans: async () => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    const scans = await nmapScanRepo.getByWorkspace(wsId);
    set({ nmapScans: scans });
  },
  createNmapGroup: async (name: string) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) throw new Error('No active workspace');
    const scan = await nmapScanRepo.create(wsId, name);
    set((s) => ({ nmapScans: [scan, ...s.nmapScans] }));
    log('create', 'page', scan.id, `Created nmap group "${name}"`);
    return scan;
  },
  importToNmapGroup: async (groupId: ID, xml: string) => {
    const { parseNmapXml } = await import('@/lib/nmap-parser');
    const parsed = parseNmapXml(xml);
    const machines = parsed.map((h) => ({
      scanId: groupId,
      ip: h.ip,
      hostname: h.hostname,
      os: h.os,
      ports: h.ports,
    }));
    await nmapMachineRepo.upsertByIp(groupId, machines);
    // Reload machines for the group
    const updated = await nmapMachineRepo.getByScan(groupId);
    set({ nmapMachines: updated });
    log('update', 'page', groupId, `Imported ${parsed.length} hosts to nmap group`);
  },
  importNmapScan: async (name: string, xml: string) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) throw new Error('No active workspace');
    const { parseNmapXml } = await import('@/lib/nmap-parser');
    const scan = await nmapScanRepo.add(wsId, name, xml);
    const parsed = parseNmapXml(xml);
    const machines = parsed.map((h) => ({
      scanId: scan.id,
      ip: h.ip,
      hostname: h.hostname,
      os: h.os,
      ports: h.ports,
    }));
    await nmapMachineRepo.addMany(machines);
    set((s) => ({ nmapScans: [scan, ...s.nmapScans] }));
    log('create', 'page', scan.id, `Imported nmap scan "${name}" (${parsed.length} hosts)`);
    return scan;
  },
  renameNmapScan: async (id: ID, name: string) => {
    await nmapScanRepo.rename(id, name);
    set((s) => ({ nmapScans: s.nmapScans.map((sc) => sc.id === id ? { ...sc, name } : sc) }));
    // Update any open tabs with the old name
    set((s) => ({ tabs: s.tabs.map((t) => t.kind === 'nmap' && t.entityId === id ? { ...t, title: name } : t) }));
  },
  deleteNmapScan: async (id: ID) => {
    await nmapScanRepo.delete(id);
    set((s) => ({
      nmapScans: s.nmapScans.filter((sc) => sc.id !== id),
      tabs: s.tabs.filter((t) => !(t.kind === 'nmap' && t.entityId === id)),
      paneLayout: collapse(removeTabsWhere(s.paneLayout, (tid) => {
        const tab = s.tabs.find((t) => t.id === tid);
        return !!tab && tab.kind === 'nmap' && tab.entityId === id;
      })),
    }));
    log('delete', 'page', id, 'Deleted nmap scan');
  },
  loadNmapMachines: async (scanId: ID) => {
    const machines = await nmapMachineRepo.getByScan(scanId);
    // Merge: keep machines from other scans, replace this scan's slice.
    // (Observer-driven reloads call this for every scan in series; a naive
    // `set({ nmapMachines: machines })` would leave only the last scan's
    // machines in memory and break the live attach UI.)
    set((s) => {
      const others = s.nmapMachines.filter((m) => m.scanId !== scanId);
      return { nmapMachines: [...others, ...machines] };
    });
  },
  updateNmapMachine: async (id: ID, data: Partial<Pick<NmapMachine, 'hostname' | 'os'>>) => {
    await nmapMachineRepo.update(id, data);
    set((s) => ({
      nmapMachines: s.nmapMachines.map((m) => m.id === id ? { ...m, ...data, updatedAt: Date.now() } : m),
    }));
    // Sync hostname to linked host node
    if (data.hostname !== undefined) {
      const machine = get().nmapMachines.find((m) => m.id === id);
      if (machine?.linkedNodeId) {
        const nodeId = machine.linkedNodeId;
        const storeNode = get().graphNodes.find((n) => n.id === nodeId);
        const nodeData = storeNode?.data ?? (await graphNodeRepo.getById(nodeId))?.data;
        if (nodeData) {
          const updatedData = { ...nodeData, hostname: data.hostname } as import('@/types').HostData;
          await graphNodeRepo.update(nodeId, { data: updatedData });
          set((s) => ({
            graphNodes: s.graphNodes.map((n) => n.id === nodeId ? { ...n, data: updatedData, updatedAt: Date.now() } : n),
          }));
        }
      }
    }
  },
  deleteNmapMachine: async (id: ID) => {
    const machine = get().nmapMachines.find((m) => m.id === id);
    // Clear ports on linked host node before deleting
    if (machine?.linkedNodeId) {
      const nodeId = machine.linkedNodeId;
      const storeNode = get().graphNodes.find((n) => n.id === nodeId);
      const nodeData = storeNode?.data ?? (await graphNodeRepo.getById(nodeId))?.data;
      if (nodeData) {
        await graphNodeRepo.update(nodeId, { data: { ...nodeData, openPorts: [] } as import('@/types').HostData });
        set((s) => ({
          graphNodes: s.graphNodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, openPorts: [] } as import('@/types').HostData, updatedAt: Date.now() } : n),
        }));
      }
    }
    await nmapMachineRepo.delete(id);
    set((s) => ({ nmapMachines: s.nmapMachines.filter((m) => m.id !== id) }));
    log('delete', 'page', id, 'Deleted nmap machine');
  },
  linkMachineToNode: async (machineId: ID, nodeId: ID) => {
    // Unlink any machine previously linked to this node
    await nmapMachineRepo.unlinkByNode(nodeId);
    // Link this machine
    await nmapMachineRepo.link(machineId, nodeId);
    const machine = get().nmapMachines.find((m) => m.id === machineId);
    // Sync open ports and hostname to host node
    if (machine) {
      const openPorts = machine.ports.filter((p) => p.state === 'open').map((p) => p.port);
      // Read node data from store or DB
      const storeNode = get().graphNodes.find((n) => n.id === nodeId);
      const nodeData = storeNode?.data ?? (await graphNodeRepo.getById(nodeId))?.data;
      const hostname = machine.hostname || (nodeData as import('@/types').HostData | undefined)?.hostname || '';
      await graphNodeRepo.update(nodeId, { data: { ...nodeData, openPorts, hostname } as import('@/types').HostData });
      // Sync hostname back to machine if it was empty
      if (!machine.hostname && hostname) {
        await nmapMachineRepo.update(machine.id, { hostname });
      }
      set((s) => ({
        nmapMachines: s.nmapMachines.map((m) => {
          if (m.id === machineId) return { ...m, linkedNodeId: nodeId, hostname: hostname || m.hostname, updatedAt: Date.now() };
          if (m.linkedNodeId === nodeId) return { ...m, linkedNodeId: undefined, updatedAt: Date.now() };
          return m;
        }),
        graphNodes: s.graphNodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, openPorts, hostname } as import('@/types').HostData, updatedAt: Date.now() } : n),
      }));
    }
    log('update', 'node', nodeId, `Linked nmap machine to host node`);
  },
  unlinkMachine: async (machineId: ID) => {
    const machine = get().nmapMachines.find((m) => m.id === machineId);
    if (!machine?.linkedNodeId) return;
    const nodeId = machine.linkedNodeId;
    await nmapMachineRepo.unlink(machineId);
    // Clear open ports on the host node
    const storeNode = get().graphNodes.find((n) => n.id === nodeId);
    const nodeData = storeNode?.data ?? (await graphNodeRepo.getById(nodeId))?.data;
    await graphNodeRepo.update(nodeId, { data: { ...nodeData, openPorts: [] } as import('@/types').HostData });
    set((s) => ({
      nmapMachines: s.nmapMachines.map((m) => m.id === machineId ? { ...m, linkedNodeId: undefined, updatedAt: Date.now() } : m),
      graphNodes: s.graphNodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, openPorts: [] } as import('@/types').HostData, updatedAt: Date.now() } : n),
    }));
    log('update', 'node', nodeId, `Unlinked nmap machine from host node`);
  },
  toggleMachinePort: (machineId: ID, port: number, enabled: boolean) => {
    const machine = get().nmapMachines.find((m) => m.id === machineId);
    if (!machine?.linkedNodeId) return;
    const nodeId = machine.linkedNodeId;
    const node = get().graphNodes.find((n) => n.id === nodeId);
    if (!node) {
      // Node not in store: update DB directly
      void graphNodeRepo.getById(nodeId).then((dbNode) => {
        if (!dbNode) return;
        const hostData = dbNode.data as import('@/types').HostData;
        const openPorts = enabled
          ? [...new Set([...hostData.openPorts, port])]
          : hostData.openPorts.filter((p) => p !== port);
        void graphNodeRepo.update(nodeId, { data: { ...hostData, openPorts } });
      });
      return;
    }
    const hostData = node.data as import('@/types').HostData;
    const openPorts = enabled
      ? [...new Set([...hostData.openPorts, port])]
      : hostData.openPorts.filter((p) => p !== port);
    void graphNodeRepo.update(nodeId, { data: { ...hostData, openPorts } });
    set((s) => ({
      graphNodes: s.graphNodes.map((n) => n.id === nodeId ? { ...n, data: { ...hostData, openPorts }, updatedAt: Date.now() } : n),
    }));
  },

  // Navigation
  pendingFocusNodeId: null,
  setPendingFocusNodeId: (nodeId) => set({ pendingFocusNodeId: nodeId }),

  // Attack Chains
  attackChains: [],
  loadAttackChains: async () => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    const chains = await attackChainRepo.getByWorkspace(wsId);
    set({ attackChains: chains });
  },
  createAttackChain: async (graphId, name, nodeIds) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) throw new Error('No active workspace');
    const chain = await attackChainRepo.create({ workspaceId: wsId, graphId, name, nodeIds });
    set((s) => ({ attackChains: [...s.attackChains, chain] }));
    log('create', 'graph', chain.id, `Created attack chain "${name}"`);
    return chain;
  },
  updateAttackChain: async (id, data) => {
    const prev = get().attackChains.find((c) => c.id === id);
    await attackChainRepo.update(id, data);
    set((s) => ({
      attackChains: s.attackChains.map((c) => c.id === id ? { ...c, ...data, updatedAt: Date.now() } : c),
    }));
    if (data.name && prev && prev.name !== data.name) {
      log('update', 'attackChain', id, `Renamed attack chain "${prev.name}" → "${data.name}"`, {
        field: 'name',
        prevValue: encodeValue(prev.name),
        newValue: encodeValue(data.name),
        reversible: true,
      });
    }
  },
  deleteAttackChain: async (id) => {
    const chain = get().attackChains.find((c) => c.id === id);
    await attackChainRepo.remove(id);
    set((s) => ({ attackChains: s.attackChains.filter((c) => c.id !== id) }));
    log('delete', 'attackChain', id, `Deleted attack chain "${chain?.name ?? id}"`, {
      prevValue: encodeValue(chain),
      reversible: !!chain,
    });
  },
  addNodesToAttackChain: async (id, nodeIds) => {
    const chain = get().attackChains.find((c) => c.id === id);
    if (!chain) return;
    const existing = new Set(chain.nodeIds);
    const merged = [...chain.nodeIds, ...nodeIds.filter((nid) => !existing.has(nid))];
    await attackChainRepo.update(id, { nodeIds: merged });
    set((s) => ({
      attackChains: s.attackChains.map((c) => c.id === id ? { ...c, nodeIds: merged, updatedAt: Date.now() } : c),
    }));
  },
  ensureAttackChainPage: async (id) => {
    const pageId = await attackChainRepo.ensurePage(id);
    if (pageId) {
      set((s) => ({
        attackChains: s.attackChains.map((c) => c.id === id ? { ...c, linkedPageId: pageId, updatedAt: Date.now() } : c),
      }));
      // Refresh the page list so the new linked page is queryable.
      void get().loadPages();
    }
    return pageId;
  },
  pendingHighlightChainId: null,
  setPendingHighlightChainId: (id) => set({ pendingHighlightChainId: id }),

  // Typst assets. Only metadata lives in the shared doc: the bytes are on
  // the server (see lib/typst-assets.ts + server/assets.mjs).
  typstAssets: [],
  loadTypstAssets: async () => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    set({ typstAssets: await typstAssetRepo.getByWorkspace(wsId) });
  },

  // Command log: the shared-doc live window. The full archive is fetched over
  // REST by the view; this loader keeps the store in sync as agents ship
  // commands (wired in shared-bindings.ts). Read-only: clients never write.
  commandLogs: [],
  loadCommandLogs: async () => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    set({ commandLogs: await commandLogRepo.getByWorkspace(wsId) });
  },

  addTypstAsset: async (file: File, kind: TypstAssetKind) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) throw new Error('No active workspace');
    const { uploadAsset, readImageSize, readFontFamily } = await import('@/lib/typst-assets');

    // Reserve a collision-free name *before* uploading so two screenshots
    // dropped with the same name don't fight over one Typst VFS path.
    const filename = await typstAssetRepo.uniqueFilename(wsId, file.name);
    const uploaded = await uploadAsset(file, { workspaceId: wsId, kind, filename });

    // Best-effort enrichment: dimensions drive the crop UI's aspect ratio,
    // and the font family is what the operator types into `#set text(font:)`.
    // Neither is worth failing the upload over.
    let width: number | null = null;
    let height: number | null = null;
    let fontFamily: string | null = null;
    if (kind === 'image' && file.type !== 'image/svg+xml') {
      try { const s = await readImageSize(file); width = s.width; height = s.height; }
      catch { /* dimensions stay unknown; the cropper falls back to the rendered size */ }
    }
    if (kind === 'font') {
      try { fontFamily = await readFontFamily(new Uint8Array(await file.arrayBuffer())); }
      catch { /* family stays unknown; the UI shows the filename instead */ }
    }

    const asset = await typstAssetRepo.create({
      id: uploaded.id,
      workspaceId: wsId,
      kind,
      filename: uploaded.filename,
      mime: uploaded.mime,
      size: uploaded.size,
      width,
      height,
      fontFamily,
    });
    set((s) => ({ typstAssets: [...s.typstAssets, asset] }));
    log('create', 'page', asset.id, `Added Typst ${kind} "${asset.filename}"`);
    return asset;
  },
  setTypstAssetCrop: async (id: ID, crop: CropRect | null, blurs?: BlurRegion[] | null) => {
    const prevAsset = get().typstAssets.find((a) => a.id === id);
    const prev = { crop: prevAsset?.crop ?? null, blurs: prevAsset?.blurs ?? null };
    // Omitting `blurs` keeps the existing regions; an empty list clears them.
    const nextBlurs = blurs === undefined ? prev.blurs : blurs && blurs.length > 0 ? blurs : null;
    await typstAssetRepo.setFraming(id, { crop, blurs: nextBlurs });
    set((s) => ({
      typstAssets: s.typstAssets.map((a) => (a.id === id ? { ...a, crop, blurs: nextBlurs } : a)),
    }));
    const name = get().typstAssets.find((a) => a.id === id)?.filename ?? id;
    const blurNote = nextBlurs
      ? ` (${nextBlurs.length} blurred region${nextBlurs.length === 1 ? '' : 's'})`
      : '';
    log(
      'update',
      'page',
      id,
      (crop ? `Cropped "${name}"` : `Cleared crop on "${name}"`) + blurNote,
      {
        field: 'crop',
        prevValue: encodeValue(prev),
        newValue: encodeValue({ crop, blurs: nextBlurs }),
      },
    );
  },
  renameTypstAsset: async (id: ID, stem: string) => {
    const wsId = get().activeWorkspaceId;
    const asset = get().typstAssets.find((a) => a.id === id);
    if (!wsId || !asset) throw new Error('asset not found');

    // The extension is deliberately not editable. It's what tells Typst which
    // decoder to use, and the bytes are normalized to match it, letting
    // someone rename shot.png to shot.jpg would reintroduce exactly the
    // decode failure that normalization exists to prevent.
    const dot = asset.filename.lastIndexOf('.');
    const ext = dot > 0 ? asset.filename.slice(dot) : '';

    // Same rules as the server's sanitizer, since this becomes a path in the
    // compiler's virtual filesystem.
    const safeStem = stem.trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.]+/, '').slice(0, 80);
    if (!safeStem) throw new Error('name cannot be empty');

    const desired = safeStem + ext;
    if (desired === asset.filename) return asset.filename;

    const filename = await typstAssetRepo.uniqueFilename(wsId, desired);
    await typstAssetRepo.rename(id, filename);
    set((s) => ({
      typstAssets: s.typstAssets.map((a) => (a.id === id ? { ...a, filename } : a)),
    }));
    log('update', 'page', id, `Renamed Typst image "${asset.filename}" → "${filename}"`, {
      field: 'filename',
      prevValue: encodeValue(asset.filename),
      newValue: encodeValue(filename),
    });
    return filename;
  },
  deleteTypstAsset: async (id: ID) => {
    const asset = get().typstAssets.find((a) => a.id === id);
    const { deleteAssetBytes, forgetAsset } = await import('@/lib/typst-assets');
    // Drop the bytes first: if that fails we keep the record, leaving the
    // asset usable rather than stranding a document reference to a file the
    // compiler can no longer resolve.
    await deleteAssetBytes(id);
    forgetAsset(id);
    await typstAssetRepo.remove(id);
    set((s) => ({ typstAssets: s.typstAssets.filter((a) => a.id !== id) }));
    log(
      'delete',
      'page',
      id,
      `Deleted Typst ${asset?.kind ?? 'asset'} "${asset?.filename ?? id}"`,
    );
  },

  // Database
  deleteDatabase: async () => {
    await db.delete();
    await db.open();
    set({
      workspaces: [],
      activeWorkspaceId: null,
      pages: [],
      graphs: [],
      graphNodes: [],
      graphEdges: [],
      changeLogs: [],
      nmapScans: [],
      nmapMachines: [],
      attackChains: [],
      typstAssets: [],
      commandLogs: [],
      tabs: [],
      activeTabId: null,
      paneLayout: createLeaf(),
      activePaneId: null,
      selectedNodeId: null,
      selectedEdgeId: null,
      searchQuery: '',
      searchResults: [],
    });
  },
});
});

// Persist UI state (tabs, panes, active workspace) on every relevant change.
// Lives outside `create()` so it can subscribe to the store after creation.
useAppStore.subscribe((state, prev) => {
  if (
    state.tabs !== prev.tabs ||
    state.activeTabId !== prev.activeTabId ||
    state.paneLayout !== prev.paneLayout ||
    state.activePaneId !== prev.activePaneId ||
    state.activeWorkspaceId !== prev.activeWorkspaceId
  ) {
    savePersistedUi({
      activeWorkspaceId: state.activeWorkspaceId,
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      paneLayout: state.paneLayout,
      activePaneId: state.activePaneId,
    });
  }
});
