import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores';
import type { NmapMachine, NmapPort, MachineOS, GraphNode, HostData } from '@/types';
import { Upload, ArrowLeft, Monitor, Skull, ChevronDown, ChevronRight, X, Link2, Unlink, Check, ExternalLink, Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { v4 as uuidv4 } from 'uuid';
import { nmapMachineRepo } from '@/db/nmap-repo';
import { graphNodeRepo } from '@/db/graph-node-repo';
import { textKey } from '@/realtime/shared-doc';
import { useYTextInput } from '@/realtime/use-y-text';

// ── OS icons (inline SVG for Windows / Linux / Attacker) ──

function WindowsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5.5l7.5-1v7H3z" /><path d="M11.5 4.3L21 3v8.5h-9.5z" /><path d="M3 12.5h7.5v7L3 18.5z" /><path d="M11.5 12.5H21V21l-9.5-1.2z" />
    </svg>
  );
}

function LinuxIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2C9 2 7 5 7 9c0 2 .5 3.5 1 5-1.5 1-3 2.5-3 4 0 1 1 2 3 2h8c2 0 3-1 3-2 0-1.5-1.5-3-3-4 .5-1.5 1-3 1-5 0-4-2-7-5-7z" />
      <circle cx="10" cy="8" r="1" fill="currentColor" /><circle cx="14" cy="8" r="1" fill="currentColor" />
      <path d="M10 11h4" />
    </svg>
  );
}

function AttackerIcon({ size = 18 }: { size?: number }) {
  return <Skull size={size} />;
}

function UnknownIcon({ size = 18 }: { size?: number }) {
  return <Monitor size={size} />;
}

function OSIcon({ os, size }: { os: MachineOS; size?: number }) {
  switch (os) {
    case 'windows': return <WindowsIcon size={size} />;
    case 'linux': return <LinuxIcon size={size} />;
    case 'attacker': return <AttackerIcon size={size} />;
    default: return <UnknownIcon size={size} />;
  }
}

const OS_OPTIONS: { value: MachineOS; label: string }[] = [
  { value: 'windows', label: 'Windows' },
  { value: 'linux', label: 'Linux' },
  { value: 'attacker', label: 'Attacker' },
  { value: 'unknown', label: 'Unknown' },
];

// ── Main view ──

export function NmapScanView({ scanId }: { scanId: string }) {
  const { nmapScans, nmapMachines, loadNmapScans, loadNmapMachines, importToNmapGroup, deleteNmapMachine, activeWorkspaceId, openTab, graphs, graphNodes, setPendingFocusNodeId } = useAppStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedMachine, setSelectedMachine] = useState<NmapMachine | null>(null);
  const [view, setView] = useState<'list' | 'detail'>('list');

  const scan = nmapScans.find((s) => s.id === scanId);

  useEffect(() => {
    if (activeWorkspaceId) void loadNmapScans();
  }, [activeWorkspaceId, loadNmapScans]);

  useEffect(() => {
    if (scanId) void loadNmapMachines(scanId);
  }, [scanId, loadNmapMachines]);

  const handleImport = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const xml = await file.text();
      await importToNmapGroup(scanId, xml);
    }
    if (fileRef.current) fileRef.current.value = '';
  }, [importToNmapGroup, scanId]);

  const handleDeleteMachine = useCallback(async (machineId: string) => {
    await deleteNmapMachine(machineId);
  }, [deleteNmapMachine]);

  const openMachine = (m: NmapMachine) => {
    setSelectedMachine(m);
    setView('detail');
  };

  const openMachineInTab = (m: NmapMachine) => {
    openTab({ id: uuidv4(), kind: 'nmap-machine', entityId: m.id, title: m.hostname || m.ip });
  };

  const goBack = () => {
    setView('list');
    setSelectedMachine(null);
    // Refresh machines in case hostname changed
    void loadNmapMachines(scanId);
  };

  if (view === 'detail' && selectedMachine) {
    return <MachineDetail machine={selectedMachine} onBack={goBack} />;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">{scan?.name ?? 'Nmap Group'}</h1>
            {scan && (
              <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
                Created {new Date(scan.importedAt).toLocaleString()} · {nmapMachines.length} host{nmapMachines.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".xml"
              multiple
              className="hidden"
              onChange={(e) => void handleImport(e.target.files)}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/20"
            >
              <Upload size={12} /> Import XML
            </button>
          </div>
        </div>

        {/* Machine grid */}
        {nmapMachines.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-[hsl(var(--muted-foreground))]">
            <Monitor size={48} className="mb-4 opacity-30" />
            <p className="text-sm">No hosts found in this scan.</p>
            <p className="mt-1 text-xs">Import an Nmap XML file to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {nmapMachines.map((machine) => {
              // Attached state is driven by the machine's own linkedNodeId so
              // the icon flips red→green even when the linked host node lives
              // in a graph that isn't currently loaded into `graphNodes`.
              const isAttached = !!machine.linkedNodeId;
              const linkedNode = machine.linkedNodeId ? graphNodes.find((n) => n.id === machine.linkedNodeId) : null;
              const linkedGraph = linkedNode ? graphs.find((g) => g.id === linkedNode.graphId) : null;
              const linkedLabel = linkedNode
                ? (linkedNode.type === 'host'
                    ? ((linkedNode.data as { hostname?: string; ip?: string }).hostname || (linkedNode.data as { ip?: string }).ip || 'host')
                    : linkedNode.type)
                : null;
              return (
                <MachineCard
                  key={machine.id}
                  machine={machine}
                  isAttached={isAttached}
                  linkedLabel={linkedLabel}
                  onClick={() => openMachine(machine)}
                  onOpenTab={() => openMachineInTab(machine)}
                  onDelete={() => void handleDeleteMachine(machine.id)}
                  onGoToNode={linkedNode && linkedGraph ? () => { setPendingFocusNodeId(linkedNode.id); openTab({ id: uuidv4(), kind: 'graph', entityId: linkedGraph.id, title: linkedGraph.name }); } : undefined}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Machine card ──

function MachineCard({ machine, isAttached, linkedLabel, onClick, onOpenTab, onDelete, onGoToNode }: { machine: NmapMachine; isAttached: boolean; linkedLabel: string | null; onClick: () => void; onOpenTab: () => void; onDelete: () => void; onGoToNode?: () => void }) {
  const openPortCount = machine.ports.filter((p) => p.state === 'open').length;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  const handleContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCtxMenu(null);
    setConfirmDelete(true);
  };

  const handleConfirmDelete = () => {
    setConfirmDelete(false);
    onDelete();
  };

  const handleClick = (e: React.MouseEvent) => {
    if (e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      onOpenTab();
    } else {
      onClick();
    }
  };

  return (
    <>
      <button
        onClick={handleClick}
        onContextMenu={handleContext}
        className={cn(
          'relative flex w-full flex-col items-center gap-2 rounded-xl border bg-[hsl(var(--card))] p-4 text-center shadow-sm transition-colors hover:bg-[hsl(var(--accent))]',
          isAttached
            ? 'border-[hsl(var(--primary))]/60 hover:border-[hsl(var(--primary))]'
            : 'border-[hsl(var(--border))] hover:border-[hsl(var(--primary))]',
        )}
      >
        {/* Top-left status icon: green host = attached to a graph node,
            red host = not attached. Hover/title shows the linked node name. */}
        <div
          className={cn(
            'absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border',
            isAttached
              ? 'border-[hsl(var(--status-green))]/60 bg-[hsl(var(--status-green))]/15 text-[hsl(var(--status-green))]'
              : 'border-[hsl(var(--status-red))]/60 bg-[hsl(var(--status-red))]/15 text-[hsl(var(--status-red))]',
          )}
          title={isAttached ? (linkedLabel ? `Attached to ${linkedLabel}` : 'Attached to a host') : 'Not attached to a host'}
          aria-label={isAttached ? (linkedLabel ? `Attached to ${linkedLabel}` : 'Attached to a host') : 'Not attached to a host'}
        >
          <Server size={11} />
        </div>
        <div className={cn(
          'flex h-10 w-10 items-center justify-center',
          machine.os === 'windows' && 'text-[hsl(var(--status-blue))]',
          machine.os === 'linux' && 'text-[hsl(var(--status-green))]',
          machine.os === 'attacker' && 'text-[hsl(var(--status-red))]',
          machine.os === 'unknown' && 'text-[hsl(var(--muted-foreground))]',
        )}>
          <OSIcon os={machine.os} size={28} />
        </div>
        <div>
          <div className="text-xs font-semibold">{machine.hostname || machine.ip}</div>
          {machine.hostname && <div className="text-[10px] text-[hsl(var(--muted-foreground))]">{machine.ip}</div>}
        </div>
        <div className="text-[9px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          {openPortCount} open port{openPortCount !== 1 ? 's' : ''}
        </div>
      </button>

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[160px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--popover))] py-1 shadow-xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {onGoToNode && (
            <button
              onClick={(e) => { e.stopPropagation(); setCtxMenu(null); onGoToNode(); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
            >
              <ExternalLink size={12} /> Go to Node
            </button>
          )}
          <button
            onClick={handleDeleteClick}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[hsl(var(--status-red))] hover:bg-[hsl(var(--status-red))]/10"
          >
            <X size={12} /> Delete Machine
          </button>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConfirmDelete(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-sm font-bold">Delete Machine</h3>
            <p className="mb-4 text-xs text-[hsl(var(--muted-foreground))]">
              Are you sure you want to delete <span className="font-semibold text-[hsl(var(--foreground))]">{machine.hostname || machine.ip}</span>? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider hover:bg-[hsl(var(--accent))]"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                className="rounded-lg border border-[hsl(var(--status-red))]/60 bg-[hsl(var(--status-red))]/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--status-red))] hover:bg-[hsl(var(--status-red))]/20"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Machine detail view ──

function MachineDetail({ machine: initialMachine, onBack }: { machine: NmapMachine; onBack: (() => void) | null }) {
  const updateNmapMachine = useAppStore((s) => s.updateNmapMachine);
  const graphNodes = useAppStore((s) => s.graphNodes);
  const graphs = useAppStore((s) => s.graphs);
  const linkMachineToNode = useAppStore((s) => s.linkMachineToNode);
  const unlinkMachine = useAppStore((s) => s.unlinkMachine);
  const toggleMachinePort = useAppStore((s) => s.toggleMachinePort);
  const nmapMachines = useAppStore((s) => s.nmapMachines);
  const openTab = useAppStore((s) => s.openTab);
  const setPendingFocusNodeId = useAppStore((s) => s.setPendingFocusNodeId);

  // Get the live version of this machine from the store (so linkedNodeId stays current)
  const liveMachine = nmapMachines.find((m) => m.id === initialMachine.id) ?? initialMachine;

  const [os, setOs] = useState<MachineOS>(initialMachine.os);

  // Reset local state when the underlying machine changes (e.g. switching tabs in the same pane)
  useEffect(() => {
    setOs(initialMachine.os);
  }, [initialMachine.id]);
  useEffect(() => {
    setOs(liveMachine.os);
  }, [liveMachine.os]);

  // Hostname is a CRDT Y.Text so two users can type into it concurrently.
  const [hostnameY, setHostnameY, hostnameYRef] = useYTextInput(
    textKey('nmapMachine', initialMachine.id, 'hostname'),
    initialMachine.hostname,
  );
  const [osDropdownOpen, setOsDropdownOpen] = useState(false);
  const [connectDialog, setConnectDialog] = useState(false);
  const [alreadyConnectedWarning, setAlreadyConnectedWarning] = useState(false);
  const [allHostNodes, setAllHostNodes] = useState<GraphNode[]>([]);
  const [connectedNodeIds, setConnectedNodeIds] = useState<Set<string>>(new Set());
  const [linkedNodeFromDb, setLinkedNodeFromDb] = useState<GraphNode | null>(null);

  // Try store first, fall back to DB for linked node
  const linkedNode = liveMachine.linkedNodeId
    ? graphNodes.find((n) => n.id === liveMachine.linkedNodeId) ?? linkedNodeFromDb
    : null;
  const linkedGraph = linkedNode ? graphs.find((g) => g.id === linkedNode.graphId) : null;

  // Load linked node from DB if not in store
  useEffect(() => {
    if (liveMachine.linkedNodeId && !graphNodes.find((n) => n.id === liveMachine.linkedNodeId)) {
      void graphNodeRepo.getById(liveMachine.linkedNodeId).then((n) => setLinkedNodeFromDb(n ?? null));
    } else {
      setLinkedNodeFromDb(null);
    }
  }, [liveMachine.linkedNodeId, graphNodes]);

  const commitHostname = () => {
    const trimmed = hostnameY.trim();
    if (trimmed !== hostnameY) setHostnameY(trimmed);
  };

  const changeOS = (newOs: MachineOS) => {
    setOs(newOs);
    setOsDropdownOpen(false);
    void updateNmapMachine(initialMachine.id, { os: newOs });
  };

  const handleConnectClick = () => {
    if (liveMachine.linkedNodeId) {
      setAlreadyConnectedWarning(true);
    } else {
      void Promise.all([
        graphNodeRepo.getAllByType('host'),
        nmapMachineRepo.getAll(),
      ]).then(([nodes, allMachines]) => {
        // `getAllByType` returns host nodes across every workspace; scope them
        // to the active workspace. Host nodes live in graphs, and `graphs` in
        // the store is the active workspace's graph list.
        const workspaceGraphIds = new Set(graphs.map((g) => g.id));
        const scopedNodes = nodes.filter((n) => workspaceGraphIds.has(n.graphId));
        setAllHostNodes(scopedNodes);
        setConnectedNodeIds(new Set(allMachines.filter((m) => m.linkedNodeId).map((m) => m.linkedNodeId!)));
        setConnectDialog(true);
      });
    }
  };

  const handleSelectHost = (node: GraphNode) => {
    void linkMachineToNode(liveMachine.id, node.id);
    setConnectDialog(false);
  };

  const handleDisconnect = () => {
    void unlinkMachine(liveMachine.id);
    setAlreadyConnectedWarning(false);
  };

  // Determine enabled ports from host node's openPorts
  const hostOpenPorts = linkedNode ? (linkedNode.data as HostData).openPorts ?? [] : [];

  const handleTogglePort = (port: number, enabled: boolean) => {
    toggleMachinePort(liveMachine.id, port, enabled);
    // If node is from DB (not store), also update local DB node state
    if (linkedNodeFromDb && liveMachine.linkedNodeId) {
      const current = (linkedNodeFromDb.data as HostData).openPorts ?? [];
      const updated = enabled ? [...new Set([...current, port])] : current.filter((p) => p !== port);
      setLinkedNodeFromDb({ ...linkedNodeFromDb, data: { ...linkedNodeFromDb.data, openPorts: updated } as HostData });
    }
  };

  const openPorts = initialMachine.ports.filter((p) => p.state === 'open');
  const closedPorts = initialMachine.ports.filter((p) => p.state !== 'open');

  const setAllPortsEnabled = (enabled: boolean) => {
    if (!liveMachine.linkedNodeId || !linkedNode) return;
    const nodeId = liveMachine.linkedNodeId;
    const hostData = linkedNode.data as HostData;
    const openPortNums = openPorts.map((p) => p.port);
    const nextOpenPorts = enabled
      ? [...new Set([...(hostData.openPorts ?? []), ...openPortNums])]
      : (hostData.openPorts ?? []).filter((p) => !openPortNums.includes(p));
    const nextData: HostData = { ...hostData, openPorts: nextOpenPorts };
    void graphNodeRepo.update(nodeId, { data: nextData });
    // Keep the zustand store in sync if the node lives there
    useAppStore.setState((s) => ({
      graphNodes: s.graphNodes.map((n) => n.id === nodeId ? { ...n, data: nextData, updatedAt: Date.now() } : n),
    }));
    // Keep the DB-fallback copy in sync if we're using it
    if (linkedNodeFromDb && linkedNodeFromDb.id === nodeId) {
      setLinkedNodeFromDb({ ...linkedNodeFromDb, data: nextData });
    }
  };

  const handleSelectAllPorts = () => setAllPortsEnabled(true);
  const handleDeselectAllPorts = () => setAllPortsEnabled(false);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        {/* Back button */}
        {onBack && (
          <button onClick={onBack} className="mb-4 flex items-center gap-1.5 text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
            <ArrowLeft size={12} /> Back to machines
          </button>
        )}

        {/* Machine header */}
        <div className="mb-6 flex items-start gap-4">
          <div className={cn(
            'flex h-14 w-14 items-center justify-center rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]',
            os === 'windows' && 'text-[hsl(var(--status-blue))]',
            os === 'linux' && 'text-[hsl(var(--status-green))]',
            os === 'attacker' && 'text-[hsl(var(--status-red))]',
            os === 'unknown' && 'text-[hsl(var(--muted-foreground))]',
          )}>
            <OSIcon os={os} size={32} />
          </div>
          <div className="flex-1">
            <div className="text-lg font-bold">{initialMachine.ip}</div>
            <div className="mt-1 flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Hostname</label>
                <input
                  ref={hostnameYRef}
                  value={hostnameY}
                  onChange={(e) => setHostnameY(e.target.value)}
                  onBlur={commitHostname}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitHostname(); }}
                  placeholder="Set hostname..."
                  className="border-b border-[hsl(var(--border))] bg-transparent px-1 text-sm outline-none focus:border-[hsl(var(--primary))]"
                />
              </div>
              <div className="relative">
                <button
                  onClick={() => setOsDropdownOpen(!osDropdownOpen)}
                  className="flex items-center gap-1 border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-0.5 text-[10px] uppercase tracking-wider hover:bg-[hsl(var(--accent))]"
                >
                  <OSIcon os={os} size={12} />
                  {OS_OPTIONS.find((o) => o.value === os)?.label ?? 'Unknown'}
                  <ChevronDown size={10} />
                </button>
                {osDropdownOpen && (
                  <div className="absolute left-0 top-full z-50 mt-1 min-w-[120px] border border-[hsl(var(--border))] bg-[hsl(var(--popover))] py-1 shadow-xl">
                    {OS_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => changeOS(opt.value)}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]',
                          os === opt.value && 'text-[hsl(var(--primary))]'
                        )}
                      >
                        <OSIcon os={opt.value} size={12} />
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Connect to host button */}
        <div className="mb-6 flex items-center gap-2">
          <button
            onClick={handleConnectClick}
            className={cn(
              'flex items-center gap-2 border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors',
              liveMachine.linkedNodeId
                ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                : 'border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]'
            )}
          >
            {liveMachine.linkedNodeId ? <><Link2 size={12} /> Connected to {linkedNode?.label ?? 'Host'}{linkedGraph ? ` (${linkedGraph.name})` : ''}</> : <><Link2 size={12} /> Connect to Host</>}
          </button>
          {linkedNode && linkedGraph && (
            <button
              onClick={() => { setPendingFocusNodeId(linkedNode.id); openTab({ id: uuidv4(), kind: 'graph', entityId: linkedGraph.id, title: linkedGraph.name }); }}
              className="flex items-center gap-2 border border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/20 transition-colors"
            >
              <ExternalLink size={12} /> Go to Node
            </button>
          )}
        </div>

        {/* Open ports table */}
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between border-b border-[hsl(var(--border))] pb-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
              Open Ports ({openPorts.length})
            </span>
            {liveMachine.linkedNodeId && openPorts.length > 0 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={handleSelectAllPorts}
                  className="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))] hover:border-emerald-500 hover:text-emerald-400 transition-colors"
                >
                  Select All
                </button>
                <button
                  onClick={handleDeselectAllPorts}
                  className="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))] hover:border-red-500 hover:text-red-400 transition-colors"
                >
                  Deselect All
                </button>
              </div>
            )}
          </div>
          {openPorts.length === 0 ? (
            <p className="py-4 text-center text-xs text-[hsl(var(--muted-foreground))]">No open ports detected</p>
          ) : (
            <div className="divide-y divide-[hsl(var(--border))]">
              {openPorts.map((p, i) => (
                <PortRow key={i} port={p} linked={!!liveMachine.linkedNodeId} enabled={hostOpenPorts.includes(p.port)} onToggle={(enabled) => handleTogglePort(p.port, enabled)} />
              ))}
            </div>
          )}
        </div>

        {/* Closed/filtered ports */}
        {closedPorts.length > 0 && (
          <div>
            <div className="mb-2 border-b border-[hsl(var(--border))] pb-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
                Closed / Filtered ({closedPorts.length})
              </span>
            </div>
            <div className="divide-y divide-[hsl(var(--border))]">
              {closedPorts.map((p, i) => (
                <PortRow key={i} port={p} muted />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Connect to host dialog */}
      {connectDialog && (
        <ConnectToHostDialog
          allHostNodes={allHostNodes}
          graphs={graphs}
          machineName={initialMachine.hostname || initialMachine.ip}
          connectedNodeIds={connectedNodeIds}
          onSelect={handleSelectHost}
          onClose={() => setConnectDialog(false)}
        />
      )}

      {/* Already connected warning */}
      {alreadyConnectedWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setAlreadyConnectedWarning(false)}>
          <div className="w-full max-w-sm border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-sm font-bold text-amber-400">Already Connected</h3>
            <p className="mb-4 text-xs text-[hsl(var(--muted-foreground))]">
              This machine is already connected to <span className="font-semibold text-[hsl(var(--foreground))]">{linkedNode?.label ?? 'a host'}</span>{linkedGraph ? ` in ${linkedGraph.name}` : ''}. Would you like to disconnect?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setAlreadyConnectedWarning(false)}
                className="rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider hover:bg-[hsl(var(--accent))]"
              >
                Cancel
              </button>
              <button
                onClick={handleDisconnect}
                className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--status-red))]/60 bg-[hsl(var(--status-red))]/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--status-red))] hover:bg-[hsl(var(--status-red))]/20"
              >
                <Unlink size={10} /> Disconnect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Connect to Host dialog with search ──

function getHostSearchText(node: GraphNode): string {
  const hd = node.data as HostData;
  const parts: string[] = [];
  if (node.label) parts.push(node.label);
  if (hd.hostname) parts.push(hd.hostname);
  if (hd.ip) parts.push(hd.ip);
  if (hd.os) parts.push(hd.os);
  if (hd.openPorts?.length) parts.push(...hd.openPorts.map(String));
  return parts.join(' ').toLowerCase();
}

function fuzzyScoreHost(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const subIdx = t.indexOf(q);
  if (subIdx !== -1) return 1000 - subIdx;
  let qi = 0, consecutive = 0, maxConsecutive = 0, matched = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) { qi++; matched++; consecutive++; maxConsecutive = Math.max(maxConsecutive, consecutive); }
    else { consecutive = 0; }
  }
  if (matched < q.length * 0.5) return 0;
  return (matched / q.length) * 100 + maxConsecutive * 10;
}

function ConnectToHostDialog({
  allHostNodes,
  graphs,
  machineName,
  connectedNodeIds,
  onSelect,
  onClose,
}: {
  allHostNodes: GraphNode[];
  graphs: import('@/types').Graph[];
  machineName: string;
  connectedNodeIds: Set<string>;
  onSelect: (node: GraphNode) => void;
  onClose: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [conflictNode, setConflictNode] = useState<GraphNode | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trySelect = (node: GraphNode) => {
    if (connectedNodeIds.has(node.id)) {
      setConflictNode(node);
    } else {
      onSelect(node);
    }
  };

  const filtered = searchQuery.trim()
    ? allHostNodes
        .map((node) => ({ node, score: fuzzyScoreHost(searchQuery, getHostSearchText(node)) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.node)
    : allHostNodes;

  // Clamp selected index when results change
  const clampedIdx = Math.min(selectedIdx, Math.max(0, filtered.length - 1));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(clampedIdx + 1, filtered.length - 1);
      setSelectedIdx(next);
      (listRef.current?.children[next] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(clampedIdx - 1, 0);
      setSelectedIdx(next);
      (listRef.current?.children[next] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter' && filtered.length > 0) {
      trySelect(filtered[clampedIdx]!);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 pb-2">
          <h3 className="mb-1 text-sm font-bold">Connect to Host</h3>
          <p className="mb-3 text-xs text-[hsl(var(--muted-foreground))]">
            Select a host node to link <span className="font-semibold text-[hsl(var(--foreground))]">{machineName}</span> to.
          </p>
          <div className="flex items-center gap-2 rounded-full border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[hsl(var(--muted-foreground))]"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input
              ref={inputRef}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSelectedIdx(0); }}
              onKeyDown={handleKeyDown}
              placeholder="Search by hostname, IP, label..."
              className="flex-1 bg-transparent text-xs text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))]"
            />
            <kbd className="text-[9px] text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))] px-1 py-0.5 rounded">ESC</kbd>
          </div>
        </div>
        {allHostNodes.length === 0 ? (
          <p className="px-4 py-4 text-center text-xs text-[hsl(var(--muted-foreground))]">No host nodes found in any attack narrative.</p>
        ) : filtered.length === 0 ? (
          <p className="px-4 py-4 text-center text-xs text-[hsl(var(--muted-foreground))]">No matching hosts found.</p>
        ) : (
          <div ref={listRef} className="max-h-60 overflow-y-auto px-4 pb-2">
            {filtered.map((node, idx) => {
              const g = graphs.find((gr) => gr.id === node.graphId);
              const hd = node.data as HostData;
              return (
                <button
                  key={node.id}
                  onClick={() => trySelect(node)}
                  className={`flex w-full items-center gap-3 rounded-lg border border-[hsl(var(--border))] px-3 py-2 text-left transition-colors mb-1 ${
                    idx === clampedIdx ? 'border-[hsl(var(--primary))] bg-[hsl(var(--accent))]' : 'hover:border-[hsl(var(--primary))] hover:bg-[hsl(var(--accent))]'
                  }`}
                >
                  <Monitor size={14} className="shrink-0 text-[hsl(var(--status-blue))]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold">{node.label}</div>
                    <div className="truncate text-[10px] text-[hsl(var(--muted-foreground))]">
                      {hd.hostname ? `${hd.hostname} · ` : ''}{hd.ip || 'No IP'}{g ? ` · ${g.name}` : ''}
                    </div>
                  </div>
                  <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${connectedNodeIds.has(node.id) ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--status-red))]'}`} title={connectedNodeIds.has(node.id) ? 'Connected' : 'Not connected'} />
                </button>
              );
            })}
          </div>
        )}
        <div className="flex justify-end border-t border-[hsl(var(--border))] px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider hover:bg-[hsl(var(--accent))]"
          >
            Cancel
          </button>
        </div>
      </div>
      {/* Conflict: host already has a linked nmap machine */}
      {conflictNode && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60" onClick={() => setConflictNode(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-sm font-bold text-[hsl(var(--status-amber))]">Host Already Connected</h3>
            <p className="mb-4 text-xs text-[hsl(var(--muted-foreground))]">
              <span className="font-semibold text-[hsl(var(--foreground))]">{conflictNode.label}</span> is already connected to another nmap machine. The existing connection will be replaced.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConflictNode(null)}
                className="rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider hover:bg-[hsl(var(--accent))]"
              >
                Cancel
              </button>
              <button
                onClick={() => { onSelect(conflictNode); setConflictNode(null); }}
                className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--status-amber))]/60 bg-[hsl(var(--status-amber))]/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--status-amber))] hover:bg-[hsl(var(--status-amber))]/20"
              >
                <Unlink size={10} /> Disconnect &amp; Reassign
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Port row with expandable script output ──

function PortRow({ port, muted, linked, enabled, onToggle }: { port: NmapPort; muted?: boolean; linked?: boolean; enabled?: boolean; onToggle?: (enabled: boolean) => void }) {
  const hasScripts = port.scripts && port.scripts.length > 0;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn(muted && 'text-[hsl(var(--muted-foreground))]')}>
      <div
        className={cn(
          'flex items-center gap-4 py-2 text-xs',
          hasScripts && 'cursor-pointer hover:bg-[hsl(var(--accent))]',
        )}
        onClick={() => hasScripts && setExpanded(!expanded)}
      >
        {linked && !muted && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle?.(!enabled); }}
            className={cn(
              'flex h-4 w-4 shrink-0 items-center justify-center border transition-colors',
              enabled
                ? 'border-emerald-500 bg-emerald-500/20 text-emerald-400'
                : 'border-[hsl(var(--border))] text-transparent hover:border-[hsl(var(--muted-foreground))]'
            )}
          >
            <Check size={10} />
          </button>
        )}
        <div className="w-5 shrink-0">
          {hasScripts && (
            expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          )}
        </div>
        <span className={cn('w-20 shrink-0 font-mono', !muted && 'text-[hsl(var(--primary))]')}>{port.port}</span>
        <span className="w-14 shrink-0 uppercase">{port.protocol}</span>
        <span className="w-32 shrink-0">{port.service || '—'}</span>
        <span className="flex-1 text-[hsl(var(--muted-foreground))]">{port.version || '—'}</span>
      </div>
      {expanded && hasScripts && (
        <div className="mb-2 ml-5 border-l-2 border-[hsl(var(--border))] pl-4">
          {port.scripts!.map((script, si) => (
            <div key={si} className="mb-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--primary))]">{script.id}</div>
              <pre className="mt-0.5 whitespace-pre-wrap break-all bg-[hsl(var(--background))] p-2 font-mono text-[11px] text-[hsl(var(--foreground))]">{script.output}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Standalone machine view (opened as a tab) ──

export function NmapMachineView({ machineId }: { machineId: string }) {
  const [machine, setMachine] = useState<NmapMachine | null>(null);
  const [loading, setLoading] = useState(true);
  const loadNmapMachines = useAppStore((s) => s.loadNmapMachines);

  useEffect(() => {
    void nmapMachineRepo.getById(machineId).then((m) => {
      setMachine(m ?? null);
      setLoading(false);
      // Ensure machine's scan group is loaded into store so liveMachine lookup works
      if (m) void loadNmapMachines(m.scanId);
    });
  }, [machineId, loadNmapMachines]);

  if (loading) return <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">Loading…</div>;
  if (!machine) return <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">Machine not found</div>;

  return <MachineDetail key={machineId} machine={machine} onBack={null} />;
}
