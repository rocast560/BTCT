import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import type { NmapMachine, NmapPort, MachineOS } from '@/types';
import { Upload, ArrowLeft, Monitor, Skull, ChevronDown, ChevronRight, Pencil, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { v4 as uuidv4 } from 'uuid';
import { nmapMachineRepo } from '@/db/nmap-repo';
import { textKey, setYTextValue } from '@/realtime/shared-doc';
import { useYTextInput } from '@/realtime/use-y-text';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

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
  const { nmapScans, nmapMachines, loadNmapScans, loadNmapMachines, importToNmapGroup, deleteNmapMachine, activeWorkspaceId, openTab, setSelectedNmapMachineId } = useAppStore(useShallow((s) => ({
    nmapScans: s.nmapScans,
    nmapMachines: s.nmapMachines,
    loadNmapScans: s.loadNmapScans,
    loadNmapMachines: s.loadNmapMachines,
    importToNmapGroup: s.importToNmapGroup,
    deleteNmapMachine: s.deleteNmapMachine,
    activeWorkspaceId: s.activeWorkspaceId,
    openTab: s.openTab,
    setSelectedNmapMachineId: s.setSelectedNmapMachineId,
  })));
  const fileRef = useRef<HTMLInputElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const scan = nmapScans.find((s) => s.id === scanId);

  useEffect(() => {
    if (activeWorkspaceId) void loadNmapScans();
  }, [activeWorkspaceId, loadNmapScans]);

  // Broadcast whichever host's row is expanded so a teammate following us
  // sees the same one; collapsing (or switching scans) clears it.
  useEffect(() => {
    setSelectedNmapMachineId(expandedId);
  }, [expandedId, setSelectedNmapMachineId]);
  useEffect(() => {
    setExpandedId(null);
  }, [scanId]);

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

  const openMachineInTab = (m: NmapMachine) => {
    openTab({ id: uuidv4(), kind: 'nmap-machine', entityId: m.id, title: m.hostname || m.ip });
  };

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

        {/* Machine rows */}
        {nmapMachines.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-[hsl(var(--muted-foreground))]">
            <Monitor size={48} className="mb-4 opacity-30" />
            <p className="text-sm">No hosts found in this scan.</p>
            <p className="mt-1 text-xs">Import an Nmap XML file to get started.</p>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-[hsl(var(--border))] overflow-hidden rounded-xl border border-[hsl(var(--border))]">
            {nmapMachines.map((machine) => (
              <MachineRow
                key={machine.id}
                machine={machine}
                expanded={expandedId === machine.id}
                onToggle={() => setExpandedId((id) => (id === machine.id ? null : machine.id))}
                onOpenTab={() => openMachineInTab(machine)}
                onDelete={() => void handleDeleteMachine(machine.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Machine row (full-width, expands in place to show its ports) ──

function MachineRow({ machine, expanded, onToggle, onOpenTab, onDelete }: {
  machine: NmapMachine;
  expanded: boolean;
  onToggle: () => void;
  onOpenTab: () => void;
  onDelete: () => void;
}) {
  const openPortCount = machine.ports.filter((p) => p.state === 'open').length;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);

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

  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCtxMenu(null);
    setRenaming(true);
  };

  const handleConfirmRename = (value: string) => {
    setRenaming(false);
    setYTextValue('nmapMachine', machine.id, 'hostname', value);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      onOpenTab();
    } else {
      onToggle();
    }
  };

  return (
    <div className="bg-[hsl(var(--card))]">
      <button
        onClick={handleClick}
        onContextMenu={handleContext}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[hsl(var(--accent))]"
      >
        <div className="w-4 shrink-0 text-[hsl(var(--muted-foreground))]">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        <div className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center',
          machine.os === 'windows' && 'text-[hsl(var(--status-blue))]',
          machine.os === 'linux' && 'text-[hsl(var(--status-green))]',
          machine.os === 'attacker' && 'text-[hsl(var(--status-red))]',
          machine.os === 'unknown' && 'text-[hsl(var(--muted-foreground))]',
        )}>
          <OSIcon os={machine.os} size={20} />
        </div>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 font-mono text-xs font-semibold">{machine.ip}</span>
          {machine.hostname && (
            <span className="truncate text-[11px] text-[hsl(var(--muted-foreground))]">{machine.hostname}</span>
          )}
        </div>
        <div className="shrink-0 text-[9px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          {openPortCount} open port{openPortCount !== 1 ? 's' : ''}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[hsl(var(--border))] px-4 py-4">
          <PortsTable machine={machine} />
        </div>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[160px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--popover))] py-1 shadow-xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={handleRenameClick}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            <Pencil size={12} /> {machine.hostname ? 'Rename Machine' : 'Add Name'}
          </button>
          <button
            onClick={handleDeleteClick}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[hsl(var(--status-red))] hover:bg-[hsl(var(--status-red))]/10"
          >
            <X size={12} /> Delete Machine
          </button>
        </div>
      )}

      {/* Rename dialog */}
      {renaming && (
        <ConfirmDialog
          title={machine.hostname ? 'Rename machine' : 'Add a name'}
          message={`Name for ${machine.ip}, synced live to every teammate.`}
          confirmLabel="Save"
          input={{ initial: machine.hostname, placeholder: 'e.g. web01' }}
          onCancel={() => setRenaming(false)}
          onConfirm={handleConfirmRename}
        />
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
    </div>
  );
}

// ── Machine detail view ──

function MachineDetail({ machine: initialMachine, onBack }: { machine: NmapMachine; onBack: (() => void) | null }) {
  const updateNmapMachine = useAppStore((s) => s.updateNmapMachine);
  const nmapMachines = useAppStore((s) => s.nmapMachines);

  // Get the live version of this machine from the store.
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
  const commitHostname = () => {
    const trimmed = hostnameY.trim();
    if (trimmed !== hostnameY) setHostnameY(trimmed);
  };

  const changeOS = (newOs: MachineOS) => {
    setOs(newOs);
    setOsDropdownOpen(false);
    void updateNmapMachine(initialMachine.id, { os: newOs });
  };

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

        <PortsTable machine={initialMachine} />
      </div>

    </div>
  );
}

// ── Ports table (open + closed/filtered), shared by the detail view and an expanded row ──

function PortsTable({ machine }: { machine: NmapMachine }) {
  const openPorts = machine.ports.filter((p) => p.state === 'open');
  const closedPorts = machine.ports.filter((p) => p.state !== 'open');

  return (
    <>
      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between border-b border-[hsl(var(--border))] pb-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
            Open Ports ({openPorts.length})
          </span>
        </div>
        {openPorts.length === 0 ? (
          <p className="py-4 text-center text-xs text-[hsl(var(--muted-foreground))]">No open ports detected</p>
        ) : (
          <div className="divide-y divide-[hsl(var(--border))]">
            {openPorts.map((p, i) => (
              <PortRow key={i} port={p} />
            ))}
          </div>
        )}
      </div>

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
    </>
  );
}

function PortRow({ port, muted }: { port: NmapPort; muted?: boolean }) {
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
        <div className="w-5 shrink-0">
          {hasScripts && (
            expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          )}
        </div>
        <span className={cn('w-20 shrink-0 font-mono', !muted && 'text-[hsl(var(--primary))]')}>{port.port}</span>
        <span className="w-14 shrink-0 uppercase">{port.protocol}</span>
        <span className="w-32 shrink-0">{port.service || 'none'}</span>
        <span className="flex-1 text-[hsl(var(--muted-foreground))]">{port.version || 'none'}</span>
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
