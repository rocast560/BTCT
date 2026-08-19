import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { NodeProperties } from '@/components/graph/NodeProperties';
import { EdgeProperties } from '@/components/graph/EdgeProperties';
import { BacklinksPanel } from '@/components/sidebar/BacklinksPanel';
import { ChangeLogPanel } from '@/components/sidebar/ChangeLogPanel';
import { PageHistoryPanel } from '@/components/sidebar/PageHistoryPanel';
import { LastEditedBadge } from '@/components/sidebar/LastEditedBadge';
import { ExportDialog } from '@/components/ui/ExportDialog';
import { PanelRightClose, AlertTriangle } from 'lucide-react';

export function RightSidebar() {
  const { selectedNodeId, selectedEdgeId, toggleRightSidebar, activeTabId, tabs, deleteDatabase } = useAppStore(useShallow((s) => ({
    selectedNodeId: s.selectedNodeId,
    selectedEdgeId: s.selectedEdgeId,
    toggleRightSidebar: s.toggleRightSidebar,
    activeTabId: s.activeTabId,
    tabs: s.tabs,
    deleteDatabase: s.deleteDatabase,
  })));
  const [exportOpen, setExportOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const deleteInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showDeleteConfirm) deleteInputRef.current?.focus();
  }, [showDeleteConfirm]);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  const handleConfirmDelete = () => {
    if (deleteConfirmText !== 'DELETE') return;
    void deleteDatabase();
    setShowDeleteConfirm(false);
    setDeleteConfirmText('');
  };

  return (
    <div className="flex h-full w-[var(--properties-width)] flex-col border-l border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--foreground))]">Properties</span>
        <button onClick={toggleRightSidebar} className="p-1 hover:bg-[hsl(var(--accent))]">
          <PanelRightClose size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {selectedNodeId && (
          <>
            <NodeProperties nodeId={selectedNodeId} />
            <div className="mt-2"><LastEditedBadge target="node" targetId={selectedNodeId} /></div>
          </>
        )}
        {selectedEdgeId && !selectedNodeId && (
          <>
            <EdgeProperties edgeId={selectedEdgeId} />
            <div className="mt-2"><LastEditedBadge target="edge" targetId={selectedEdgeId} /></div>
          </>
        )}
        {!selectedNodeId && !selectedEdgeId && activeTab?.kind === 'page' && (
          <>
            <BacklinksPanel pageId={activeTab.entityId} />
            <div className="mt-2"><LastEditedBadge target="page" targetId={activeTab.entityId} /></div>
            <div className="mt-4 border-t border-[hsl(var(--border))] pt-3">
              <PageHistoryPanel pageId={activeTab.entityId} />
            </div>
          </>
        )}
        {!selectedNodeId && !selectedEdgeId && !activeTab && (
          <p className="text-sm text-[hsl(var(--muted-foreground))]">Select a node, edge, or open a page to see properties.</p>
        )}
        <div className="mt-4 border-t border-[hsl(var(--border))] pt-3">
          <ChangeLogPanel />
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-[hsl(var(--border))] p-3">
        <button
          onClick={() => setExportOpen(true)}
          className="w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
        >
          Export / Import
        </button>
        <button
          onClick={() => { setShowDeleteConfirm(true); setDeleteConfirmText(''); }}
          className="w-full rounded-lg border border-[hsl(var(--destructive))] bg-[hsl(var(--card))] px-3 py-2 text-xs uppercase tracking-wide text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive))] hover:text-white"
        >
          Delete Database
        </button>
      </div>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowDeleteConfirm(false)}>
          <div className="w-80 rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2 text-[hsl(var(--status-red))]">
              <AlertTriangle size={16} />
              <span className="text-sm font-semibold">Delete Database</span>
            </div>
            <p className="mb-1 text-xs text-[hsl(var(--muted-foreground))]">
              This will permanently delete all workspaces, pages, and data.
            </p>
            <p className="mb-3 text-xs text-[hsl(var(--muted-foreground))]">
              Type <span className="font-mono font-bold text-[hsl(var(--foreground))]">DELETE</span> to confirm.
            </p>
            <input
              ref={deleteInputRef}
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmDelete(); if (e.key === 'Escape') setShowDeleteConfirm(false); }}
              placeholder="Type DELETE..."
              className="mb-3 w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 text-xs outline-none focus:border-[hsl(var(--primary))]"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="rounded-lg px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={deleteConfirmText !== 'DELETE'}
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
