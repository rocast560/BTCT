import { useEffect } from 'react';
import { useAppStore } from '@/stores';
import { History } from 'lucide-react';

export function ChangeLogPanel() {
  const changeLogs = useAppStore((s) => s.changeLogs);
  const loadChangeLogs = useAppStore((s) => s.loadChangeLogs);

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

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
        <History size={12} />
        History
      </div>
      {changeLogs.map((entry) => (
        <div key={entry.id} className="border-l-2 border-[hsl(var(--border))] pl-2 py-1">
          <div className="text-xs leading-tight">{entry.summary}</div>
          <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
            {formatTimeAgo(entry.timestamp)}
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
