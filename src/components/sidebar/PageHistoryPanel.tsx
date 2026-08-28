import { useCallback, useEffect, useState } from 'react';
import { Clock, History, Save, X } from 'lucide-react';
import { useAppStore } from '@/stores';
import { createVersion, listVersions, type VersionListResponse } from '@/realtime/page-history-api';
import { formatVersionTime, dayLabel, versionLabel } from '@/lib/page-history';

/**
 * Properties-panel entry point for a page's version history: a one-line
 * summary of the latest version, a "save a named version" field, and the
 * button that opens the full History tab (viewer + timeline + restore).
 */
export function PageHistoryPanel({ pageId }: { pageId: string }) {
  const page = useAppStore((s) => s.pages.find((p) => p.id === pageId));
  const openTab = useAppStore((s) => s.openTab);
  const closeTab = useAppStore((s) => s.closeTab);
  // The History tab for this page, if open: the button below toggles it.
  const historyTab = useAppStore((s) => s.tabs.find((t) => t.kind === 'history' && t.entityId === pageId));
  const [data, setData] = useState<VersionListResponse | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listVersions(pageId).then(setData).catch(() => setData(null));
  }, [pageId]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const flash = (msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(null), 3000);
  };

  const saveNamed = async () => {
    setBusy(true);
    try {
      await createVersion(pageId, { name: label.trim() || null, trigger: 'named' });
      setLabel('');
      flash('Version saved.');
      refresh();
    } catch (err) {
      flash(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const openHistory = () => {
    openTab({
      id: `history:${pageId}`,
      kind: 'history',
      entityId: pageId,
      title: `History: ${page?.title ?? 'page'}`,
    });
  };

  const latest = data?.versions[0] ?? null;
  const count = data?.versions.length ?? 0;
  const latestUser = latest ? data?.users[String(latest.changedBy[0] ?? latest.createdBy ?? 0)] : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
        <Clock size={12} />
        Page Versions
      </div>

      <div className="text-xs text-[hsl(var(--muted-foreground))]">
        {latest ? (
          <>
            <span className="text-[hsl(var(--foreground))]">{count} version{count === 1 ? '' : 's'}</span>
            <span aria-hidden> · </span>
            latest {versionLabel(latest).toLowerCase()} {dayLabel(latest.createdAt).toLowerCase()} at {formatVersionTime(latest.createdAt)}
            {latestUser && (
              <>
                {' '}by{' '}
                <span className="inline-flex items-center gap-1 text-[hsl(var(--foreground))]">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: latestUser.color }} aria-hidden />
                  {latestUser.username}
                </span>
              </>
            )}
          </>
        ) : (
          'No versions yet. One is recorded about two minutes after editing stops.'
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void saveNamed(); }}
          placeholder="Name this version"
          className="min-w-0 flex-1 rounded-md border border-[hsl(var(--border))] bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-[hsl(var(--primary))]"
        />
        <button
          type="button"
          onClick={() => void saveNamed()}
          disabled={busy}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-[hsl(var(--border))] px-2.5 py-1.5 text-xs hover:bg-[hsl(var(--accent))] disabled:opacity-50"
          title="Save the current page body as a named version"
        >
          <Save size={12} /> Save
        </button>
      </div>

      <button
        type="button"
        onClick={historyTab ? () => closeTab(historyTab.id) : openHistory}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs font-medium hover:bg-[hsl(var(--accent))]"
      >
        {historyTab ? <X size={13} /> : <History size={13} />}
        {historyTab ? 'Close version history' : 'Open version history'}
      </button>

      {status && (
        <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))] px-2.5 py-1.5 text-[11px]">
          {status}
        </div>
      )}
    </div>
  );
}
