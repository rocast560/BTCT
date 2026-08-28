import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores';
import { History, Undo2 } from 'lucide-react';
import type { ChangeLogEntry } from '@/types';

/**
 * Workspace activity: renames, creations, deletions and other metadata
 * events from the change log, newest first, each restorable to its previous
 * value. Page bodies are versioned separately (PageHistoryPanel).
 */
export function ChangeLogPanel() {
  const changeLogs = useAppStore((s) => s.changeLogs);
  const loadChangeLogs = useAppStore((s) => s.loadChangeLogs);
  const restoreFromLog = useAppStore((s) => s.restoreFromLog);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void loadChangeLogs();
  }, [loadChangeLogs]);

  const handleRestore = async (entry: ChangeLogEntry) => {
    setPendingId(entry.id);
    setStatus(null);
    try {
      const ok = await restoreFromLog(entry.id);
      setStatus(ok ? 'Restored.' : 'Could not restore (entity may no longer exist).');
    } catch (err) {
      setStatus(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPendingId(null);
      window.setTimeout(() => setStatus(null), 3000);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
        <History size={12} />
        History
      </div>

      {status && (
        <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))] px-2.5 py-1.5 text-[11px]">
          {status}
        </div>
      )}

      {changeLogs.length === 0 ? (
        <div className="text-xs text-[hsl(var(--muted-foreground))]">No changes recorded yet.</div>
      ) : (
        <ol className="relative ml-1 border-l border-[hsl(var(--border))] pl-4">
          {changeLogs.map((entry) => (
            <li key={entry.id} className="relative py-2 first:pt-0 last:pb-0">
              <span
                className="absolute -left-[21px] top-2.5 h-2 w-2 rounded-full ring-2 ring-[hsl(var(--card))] first:top-1"
                style={{ backgroundColor: entry.userColor ?? 'hsl(var(--muted-foreground))' }}
                aria-hidden
              />
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs leading-snug break-words">{entry.summary}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">
                    {entry.userName && <span>{entry.userName}</span>}
                    {entry.userName && <span aria-hidden>·</span>}
                    <span title={new Date(entry.timestamp).toLocaleString()}>{formatTimeAgo(entry.timestamp)}</span>
                  </div>
                </div>
                {entry.reversible && entry.action !== 'restore' && (
                  <button
                    type="button"
                    onClick={() => void handleRestore(entry)}
                    disabled={pendingId === entry.id}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2 py-1 text-[11px] hover:bg-[hsl(var(--accent))] disabled:opacity-50"
                    title="Restore to the previous value"
                  >
                    <Undo2 size={11} /> Undo
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
