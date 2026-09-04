import { useCallback, useMemo, useState } from 'react';
import { useAppStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { ChevronRight, Search, Download, Crosshair, Copy, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SITE_NODE_TYPES, type SiteMapNode, type SiteNodeType } from '@/types';
import { SITE_TYPE_META, statusColor, shortLabel } from './site-visuals';

const CSV_COLS: ReadonlyArray<[string, (n: SiteMapNode) => string]> = [
  ['type', (n) => n.type],
  ['method', (n) => n.method],
  ['url', (n) => n.url],
  ['status', (n) => (n.status == null ? '' : String(n.status))],
  ['contentType', (n) => n.contentType],
  ['title', (n) => n.title],
  ['params', (n) => n.params.join(' ')],
  ['sources', (n) => n.sources.join(' ')],
  ['tags', (n) => n.tags.join(' ')],
];

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function toCsv(rows: SiteMapNode[]): string {
  const header = CSV_COLS.map(([h]) => h).join(',');
  const lines = rows.map((r) => CSV_COLS.map(([, get]) => csvCell(get(r))).join(','));
  return [header, ...lines].join('\n');
}

function matches(n: SiteMapNode, q: string): boolean {
  if (!q) return true;
  const hay = `${n.url} ${n.title} ${n.method} ${n.status ?? ''} ${n.contentType} ${n.tags.join(' ')} ${n.sources.join(' ')}`.toLowerCase();
  return hay.includes(q);
}

export function EndpointList({ siteMapId }: { siteMapId: string }) {
  const { siteMapNodes, setPendingFocusNodeId, deleteSiteMapNode } = useAppStore(useShallow((s) => ({
    siteMapNodes: s.siteMapNodes,
    setPendingFocusNodeId: s.setPendingFocusNodeId,
    deleteSiteMapNode: s.deleteSiteMapNode,
  })));

  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<SiteNodeType>>(new Set());
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () => siteMapNodes.filter((n) => n.siteMapId === siteMapId).filter((n) => matches(n, q)),
    [siteMapNodes, siteMapId, q],
  );

  const grouped = useMemo(() => {
    const byType = new Map<SiteNodeType, SiteMapNode[]>();
    for (const n of rows) {
      const arr = byType.get(n.type) ?? [];
      arr.push(n);
      byType.set(n.type, arr);
    }
    for (const arr of byType.values()) arr.sort((a, b) => a.url.localeCompare(b.url));
    return byType;
  }, [rows]);

  const toggle = useCallback((t: SiteNodeType) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }, []);

  const exportCsv = useCallback(() => {
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'endpoints.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [rows]);

  const copyUrl = useCallback((url: string) => {
    try { void navigator.clipboard.writeText(url); } catch { /* ignore */ }
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[hsl(var(--background))]">
      <div className="flex items-center gap-2 border-b border-[hsl(var(--border))] px-3 py-2">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter endpoints, paths, params…"
            className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] py-1 pl-7 pr-2 text-[11px] outline-none focus:border-[hsl(var(--primary))]"
          />
        </div>
        <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{rows.length}</span>
        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          title="Export CSV"
          className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-1 text-[10px] hover:bg-[hsl(var(--accent))] disabled:opacity-40"
        >
          <Download size={11} /> CSV
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 && (
          <div className="p-6 text-center text-xs text-[hsl(var(--muted-foreground))]">Nothing to show.</div>
        )}
        {SITE_NODE_TYPES.map((t) => {
          const items = grouped.get(t);
          if (!items || items.length === 0) return null;
          const meta = SITE_TYPE_META[t];
          const Icon = meta.icon;
          const isCollapsed = collapsed.has(t);
          return (
            <div key={t}>
              <button
                onClick={() => toggle(t)}
                className="flex w-full items-center gap-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]/40 px-3 py-1.5 text-left"
              >
                <ChevronRight size={11} className={cn('transition-transform', !isCollapsed && 'rotate-90')} />
                <Icon size={12} />
                <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: meta.color }}>{meta.label}</span>
                <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{items.length}</span>
              </button>
              {!isCollapsed && items.map((n) => (
                <div
                  key={n.id}
                  className="group flex items-center gap-2 border-b border-[hsl(var(--border))]/50 px-3 py-1.5 text-[11px] hover:bg-[hsl(var(--accent))]/40"
                >
                  {n.method && (
                    <span className="w-12 shrink-0 font-mono text-[9px] uppercase text-[hsl(var(--muted-foreground))]">{n.method}</span>
                  )}
                  <span className="w-10 shrink-0 text-right font-mono text-[10px]" style={{ color: statusColor(n.status) }}>{n.status ?? ''}</span>
                  <button
                    onClick={() => setPendingFocusNodeId(n.id)}
                    className="min-w-0 flex-1 truncate text-left"
                    title={n.url}
                  >
                    {n.title || shortLabel(n.url)}
                  </button>
                  {n.contentType && (
                    <span className="hidden shrink-0 truncate font-mono text-[9px] text-[hsl(var(--muted-foreground))] md:block md:max-w-[120px]">{n.contentType}</span>
                  )}
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                    <button onClick={() => setPendingFocusNodeId(n.id)} title="Locate on graph" className="rounded p-1 hover:bg-[hsl(var(--accent))]"><Crosshair size={11} /></button>
                    <button onClick={() => copyUrl(n.url)} title="Copy URL" className="rounded p-1 hover:bg-[hsl(var(--accent))]"><Copy size={11} /></button>
                    {confirmId === n.id ? (
                      <>
                        <button onClick={() => { setConfirmId(null); void deleteSiteMapNode(n.id); }} className="rounded px-1 py-0.5 text-[9px] text-[hsl(var(--status-red))] hover:bg-[hsl(var(--accent))]">Delete</button>
                        <button onClick={() => setConfirmId(null)} className="rounded px-1 py-0.5 text-[9px] hover:bg-[hsl(var(--accent))]">Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => setConfirmId(n.id)} title="Delete node" className="rounded p-1 text-[hsl(var(--status-red))] hover:bg-[hsl(var(--accent))]"><Trash2 size={11} /></button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
