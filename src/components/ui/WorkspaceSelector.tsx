import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '@/stores';
import { Briefcase, Plus, Trash2, ChevronUp, AlertTriangle } from 'lucide-react';

export function WorkspaceSelector() {
  const { workspaces, activeWorkspaceId, setActiveWorkspace, createWorkspace, deleteWorkspace, loadPages, loadGraphs } =
    useAppStore();
  const [isOpen, setIsOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const confirmInputRef = useRef<HTMLInputElement>(null);

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);

  useEffect(() => {
    if (pendingDelete) confirmInputRef.current?.focus();
  }, [pendingDelete]);

  const handleSwitch = (id: string) => {
    setActiveWorkspace(id);
    void loadPages();
    void loadGraphs();
    setIsOpen(false);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const ws = await createWorkspace(newName.trim(), '');
    setNewName('');
    handleSwitch(ws.id);
  };

  const handleConfirmDelete = () => {
    if (!pendingDelete || confirmText !== pendingDelete.name) return;
    void deleteWorkspace(pendingDelete.id);
    setPendingDelete(null);
    setConfirmText('');
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
      >
        <Briefcase size={12} />
        <span className="flex-1 truncate text-left">{activeWs?.name ?? 'No workspace'}</span>
        <ChevronUp size={12} className={`transition-transform ${isOpen ? '' : 'rotate-180'}`} />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 right-0 mb-1.5 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--popover))] p-2 shadow-xl">
          <div className="mb-2 px-1 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Workspaces</div>
          {workspaces.map((ws) => (
            <div key={ws.id} className="group flex items-center gap-1">
              <button
                onClick={() => handleSwitch(ws.id)}
                className={`flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-xs ${
                  ws.id === activeWorkspaceId ? 'bg-[hsl(var(--accent))]' : 'hover:bg-[hsl(var(--accent))]'
                }`}
              >
                <Briefcase size={10} />
                <span className="truncate">{ws.name}</span>
              </button>
              <button
                onClick={() => { setPendingDelete({ id: ws.id, name: ws.name }); setConfirmText(''); }}
                className="hidden rounded-md p-1 text-[hsl(var(--status-red))] hover:bg-[hsl(var(--status-red))]/15 group-hover:block"
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
          <div className="mt-2 flex items-center gap-1 border-t border-[hsl(var(--border))] pt-2">
            <input
              placeholder="New workspace..."
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
              className="flex-1 rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-xs outline-none focus:border-[hsl(var(--primary))]"
            />
            <button onClick={() => void handleCreate()} className="rounded-md p-1 hover:bg-[hsl(var(--accent))]">
              <Plus size={12} />
            </button>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setPendingDelete(null)}>
          <div className="w-80 rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2 text-[hsl(var(--status-red))]">
              <AlertTriangle size={16} />
              <span className="text-sm font-semibold">Delete Workspace</span>
            </div>
            <p className="mb-1 text-xs text-[hsl(var(--muted-foreground))]">
              This will permanently delete the workspace and all its data.
            </p>
            <p className="mb-3 text-xs text-[hsl(var(--muted-foreground))]">
              Type <span className="font-mono font-bold text-[hsl(var(--foreground))]">{pendingDelete.name}</span> to confirm.
            </p>
            <input
              ref={confirmInputRef}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmDelete(); if (e.key === 'Escape') setPendingDelete(null); }}
              placeholder="Type workspace name..."
              className="mb-3 w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 text-xs outline-none focus:border-[hsl(var(--primary))]"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingDelete(null)}
                className="rounded-lg px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={confirmText !== pendingDelete.name}
                className="rounded-lg bg-[hsl(var(--status-red))] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed"
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
