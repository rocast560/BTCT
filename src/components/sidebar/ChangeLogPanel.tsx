import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores';
import { History, Undo2 } from 'lucide-react';
import type { ChangeLogEntry } from '@/types';

export function ChangeLogPanel() {
  const changeLogs = useAppStore((s) => s.changeLogs);
  const loadChangeLogs = useAppStore((s) => s.loadChangeLogs);
  const restoreFromLog = useAppStore((s) => s.restoreFromLog);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void loadChangeLogs();
  }, [loadChangeLogs]);

  if (changeLogs.length === 0) {
    return (
      <div className="text-xs text-[hsl(var(--muted-foreground))]">
        No changes recorded yet.
      </div>
    );
  }

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
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
        <History size={12} />
        History
      </div>
      {status && (
        <div className="rounded border border-[hsl(var(--border))] bg-[hsl(var(--accent))] px-2 py-1 text-[10px]">
          {status}
        </div>
      )}
      {changeLogs.map((entry) => (
        <div key={entry.id} className="border-l-2 border-[hsl(var(--border))] pl-2 py-1">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-xs leading-tight break-words">{entry.summary}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">
                {entry.userName && (
                  <span className="flex items-center gap-1">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: entry.userColor ?? '#888' }}
                      aria-hidden
                    />
                    {entry.userName}
                  </span>
                )}
                {entry.userName && <span aria-hidden>·</span>}
                <span>{formatTimeAgo(entry.timestamp)}</span>
              </div>
            </div>
            {entry.reversible && entry.action !== 'restore' && (
              <button
                type="button"
                onClick={() => void handleRestore(entry)}
                disabled={pendingId === entry.id}
                className="flex shrink-0 items-center gap-1 border border-[hsl(var(--border))] px-1.5 py-0.5 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))] disabled:opacity-50"
                title="Restore to the previous value"
              >
                <Undo2 size={10} /> Restore
              </button>
            )}
          </div>
        </div>
      ))}
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
