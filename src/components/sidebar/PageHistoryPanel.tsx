import { useEffect, useState, useCallback } from 'react';
import { Save, Undo2, Clock } from 'lucide-react';
import { pageSnapshotRepo } from '@/db';
import { captureSnapshotNow, restoreSnapshot } from '@/realtime/page-snapshots';
import type { PageSnapshot } from '@/types';
import { useAppStore } from '@/stores';

export function PageHistoryPanel({ pageId }: { pageId: string }) {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const [snaps, setSnaps] = useState<PageSnapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [labelInput, setLabelInput] = useState('');

  const refresh = useCallback(() => {
    void pageSnapshotRepo.getByPage(pageId).then(setSnaps);
  }, [pageId]);

  useEffect(() => { refresh(); }, [refresh]);
  // Re-poll periodically — the shared doc may emit new snapshots from
  // another client. (Cheap; the snapshot list is small.)
  useEffect(() => {
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const handleSaveNamed = async () => {
    if (!activeWorkspaceId) return;
    setBusy(true);
    try {
      await captureSnapshotNow(pageId, activeWorkspaceId, labelInput.trim() || null);
      setLabelInput('');
      setStatus('Version saved.');
      refresh();
    } catch (err) {
      setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      window.setTimeout(() => setStatus(null), 3000);
    }
  };

  const handleRestore = async (snap: PageSnapshot) => {
    if (!window.confirm(`Replace the current page body with this version from ${new Date(snap.timestamp).toLocaleString()}?\n\nThis change is collaborative — every connected user will see the rollback.`)) return;
    setBusy(true);
    try {
      restoreSnapshot(pageId, snap.updateBase64);
      setStatus('Restored. The editor should refresh to the snapshot in a moment.');
    } catch (err) {
      setStatus(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      window.setTimeout(() => setStatus(null), 4000);
    }
  };

  const handleDelete = async (snap: PageSnapshot) => {
    if (!window.confirm('Delete this saved version? (Will not affect the live page.)')) return;
    await pageSnapshotRepo.remove(snap.id);
    refresh();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
        <Clock size={12} />
        Page Versions
      </div>

      <div className="flex items-center gap-1">
        <input
          type="text"
          value={labelInput}
          onChange={(e) => setLabelInput(e.target.value)}
          placeholder="Label (optional)"
          className="flex-1 border border-[hsl(var(--border))] bg-transparent px-2 py-1 text-xs outline-none focus:border-[hsl(var(--primary))]"
        />
        <button
          type="button"
          onClick={() => void handleSaveNamed()}
          disabled={busy}
          className="flex items-center gap-1 border border-[hsl(var(--border))] px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))] disabled:opacity-50"
          title="Save the current page body as a named version"
        >
          <Save size={10} /> Save
        </button>
      </div>

      {status && (
        <div className="rounded border border-[hsl(var(--border))] bg-[hsl(var(--accent))] px-2 py-1 text-[10px]">
          {status}
        </div>
      )}

      {snaps.length === 0 ? (
        <div className="text-xs text-[hsl(var(--muted-foreground))]">
          No versions yet. Auto-snapshots appear ~2 minutes after you stop typing, or click <strong>Save</strong> to bookmark one now.
        </div>
      ) : (
        <ul className="space-y-1">
          {snaps.map((s) => (
            <li key={s.id} className="border-l-2 border-[hsl(var(--border))] pl-2 py-1">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs leading-tight break-words">
                    {s.label ? <strong>{s.label}</strong> : <em className="text-[hsl(var(--muted-foreground))]">Auto-saved</em>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">
                    {s.userName && (
                      <span className="flex items-center gap-1">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: s.userColor ?? '#888' }}
                          aria-hidden
                        />
                        {s.userName}
                      </span>
                    )}
                    {s.userName && <span aria-hidden>·</span>}
                    <span>{new Date(s.timestamp).toLocaleString()}</span>
                    <span aria-hidden>·</span>
                    <span>{(s.byteLength / 1024).toFixed(1)} KB</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => void handleRestore(s)}
                    disabled={busy}
                    className="flex items-center gap-1 rounded-full border border-[hsl(var(--border))] px-2 py-0.5 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))] disabled:opacity-50"
                  >
                    <Undo2 size={10} /> Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(s)}
                    disabled={busy}
                    className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
