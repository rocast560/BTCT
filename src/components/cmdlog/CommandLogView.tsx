import { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import { useAppStore } from '@/stores';
import { useAuthStore } from '@/auth/auth-store';
import type { CommandLogEntry } from '@/types';
import { Terminal, Download, RefreshCw, Search, X, CircleDot, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  emptyFilter, applyCmdLogFilter, statusOf,
  distinctOperators, distinctTools, distinctHosts, toCsv,
  type CmdLogFilter, type CmdLogStatus,
} from '@/lib/cmdlog-filter';

const GRID = 'grid grid-cols-[136px_120px_96px_1fr_54px_72px] gap-2';

// Preset time windows for the "since" filter. `null` = all time.
const TIME_PRESETS: Array<[string, number | null]> = [
  ['All', null], ['1h', 3600_000], ['24h', 86_400_000], ['7d', 604_800_000],
];

// Deterministic hue from an operator name so each operator keeps one color
// across sessions (operators aren't BTCT users, so there's no stored color).
// Memoized: this ran twice per row per render over the whole (up to 5000-row)
// archive; the operator set is tiny, so cache the computed color by name.
const operatorColorCache = new Map<string, string>();
function operatorColor(name: string): string {
  const hit = operatorColorCache.get(name);
  if (hit) return hit;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const color = `hsl(${h % 360} 65% 55%)`;
  operatorColorCache.set(name, color);
  return color;
}

// Cap how many rows are put in the DOM at once. The count still reports the
// true total; "Search full archive" can return 5000 rows, and mounting all
// of them (6 cells + 2 icons each) is what made that button janky.
const MAX_RENDERED_ROWS = 400;

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function download(name: string, mime: string, data: string) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// One log row. Memoized so a live-capture batch (which changes only a few
// rows) doesn't re-render the entire visible archive.
const LogRow = memo(function LogRow({ r }: { r: CommandLogEntry }) {
  const st = statusOf(r);
  const color = operatorColor(r.operator);
  return (
    <div
      style={{ borderLeft: `3px solid ${color}` }}
      className={cn(
        GRID,
        'items-start px-3 py-2 text-xs hover:bg-[hsl(var(--accent))]/30',
        st === 'failed' && 'bg-[hsl(var(--status-red))]/5',
      )}
    >
      <div className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]" title={new Date(r.startedAt).toISOString()}>
        {fmtTime(r.startedAt)}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <CircleDot size={9} className="shrink-0" style={{ color }} />
        <span className="truncate" title={r.host ? `${r.operator} @ ${r.host}` : r.operator}>{r.operator}</span>
      </div>
      <div className="truncate font-mono text-[11px] text-[hsl(var(--status-green))]" title={r.tool}>{r.tool}</div>
      <div className="min-w-0 break-all font-mono text-[11px]" title={r.cwd ? `cwd: ${r.cwd}` : undefined}>
        {r.command}
      </div>
      <div className="text-center">
        {st === 'running' ? (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[hsl(var(--status-amber))]" title="Running…" />
        ) : (
          <span className={cn('font-mono text-[11px]', st === 'success' ? 'text-[hsl(var(--muted-foreground))]' : 'text-[hsl(var(--status-red))]')}>
            {r.exitCode}
          </span>
        )}
      </div>
      <div className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{fmtDuration(r.durationMs)}</div>
    </div>
  );
});

export function CommandLogView() {
  const liveRows = useAppStore((s) => s.commandLogs);      // shared-doc live window
  const workspaceId = useAppStore((s) => s.activeWorkspaceId);
  const cmdlogQuery = useAuthStore((s) => s.cmdlogQuery);

  const [archive, setArchive] = useState<CommandLogEntry[]>([]);   // from REST
  const [loading, setLoading] = useState(true);
  const [archiveWindow, setArchiveWindow] = useState<'recent' | 'full'>('recent');
  const [filter, setFilter] = useState<CmdLogFilter>(() => emptyFilter());
  const [since, setSince] = useState<number | null>(86_400_000);   // default: last 24h
  const [adding, setAdding] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Seed the archive from REST so history shows even on a cold shared doc.
  // `full` fetches everything; `recent` limits to the last 24h.
  const fetchArchive = useCallback(async (mode: 'recent' | 'full') => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const rows = await cmdlogQuery({
        workspaceId,
        from: mode === 'recent' ? Date.now() - 86_400_000 : undefined,
        limit: mode === 'full' ? 5000 : 1000,
      });
      setArchive(rows);
      setArchiveWindow(mode);
    } catch {
      setArchive([]);   // ingest disabled or offline: fall back to the live window only
    } finally {
      setLoading(false);
    }
  }, [workspaceId, cmdlogQuery]);

  useEffect(() => { void fetchArchive('recent'); }, [fetchArchive]);

  // Merge REST archive with the live CRDT window, CRDT winning on id (it carries
  // the freshest exit/duration). Live rows also surface commands that arrived
  // after the last archive fetch without a re-query.
  const merged = useMemo(() => {
    const byId = new Map<string, CommandLogEntry>();
    for (const r of archive) byId.set(r.id, r);
    for (const r of liveRows) byId.set(r.id, r);
    return [...byId.values()];
  }, [archive, liveRows]);

  const operators = useMemo(() => distinctOperators(merged), [merged]);
  const tools = useMemo(() => distinctTools(merged), [merged]);
  const hosts = useMemo(() => distinctHosts(merged), [merged]);

  // A manually-added entry is written server-side to SQLite + CRDT; the CRDT
  // push refreshes liveRows on its own, but merge it into `archive` too so it
  // shows instantly regardless of the current archive window.
  const onManualAdded = useCallback((log: CommandLogEntry) => {
    setArchive((prev) => (prev.some((r) => r.id === log.id) ? prev : [log, ...prev]));
  }, []);

  // Advance the relative-time window on a coarse tick. Reading Date.now()
  // inside the memo froze the window at mount, so "last 24h" never moved;
  // recomputing it every render would instead rebuild `rows` constantly.
  // A 30s tick advances the boundary without per-render churn.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [since]);

  const effectiveFilter = useMemo<CmdLogFilter>(
    () => ({ ...filter, from: since !== null ? nowTick - since : filter.from }),
    [filter, since, nowTick],
  );
  const rows = useMemo(() => applyCmdLogFilter(merged, effectiveFilter), [merged, effectiveFilter]);

  const toggleIn = (key: 'operators' | 'tools') => (value: string) => {
    setFilter((f) => {
      const next = new Set(f[key]);
      if (next.has(value)) next.delete(value); else next.add(value);
      return { ...f, [key]: next };
    });
  };
  const running = rows.filter((r) => statusOf(r) === 'running').length;

  if (loading && !merged.length) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">
        Loading command log…
      </div>
    );
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://<btct-host>:8080';

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold">
              <Terminal size={18} className="text-[hsl(var(--status-green))]" />
              Command Log
            </h1>
            <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
              Whitelisted commands captured from every operator's shell.
              {' · '}{rows.length} command{rows.length !== 1 ? 's' : ''}
              {running > 0 ? ` · ${running} running` : ''}
              {' · '}showing {archiveWindow === 'full' ? 'full archive' : 'last 24h'} + live
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 px-3 py-1.5 text-[11px] font-medium text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/20"
              title="Manually add a command-log entry"
            >
              <Plus size={12} /> Add entry
            </button>
            <button
              onClick={() => void fetchArchive(archiveWindow === 'full' ? 'full' : 'recent')}
              className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-1.5 text-[11px] hover:bg-[hsl(var(--accent))]"
              title="Refresh from the archive"
            >
              <RefreshCw size={12} className={cn(loading && 'animate-spin')} /> Refresh
            </button>
            <button
              onClick={() => download(`command-log-${Date.now()}.csv`, 'text/csv', toCsv(rows))}
              className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-1.5 text-[11px] hover:bg-[hsl(var(--accent))]"
              title="Export the filtered rows as CSV"
            >
              <Download size={12} /> CSV
            </button>
            <button
              onClick={() => download(`command-log-${Date.now()}.json`, 'application/json', JSON.stringify(rows, null, 2))}
              className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-1.5 text-[11px] hover:bg-[hsl(var(--accent))]"
              title="Export the filtered rows as JSON"
            >
              <Download size={12} /> JSON
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3">
          {/* Search + status + time + archive scope */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1">
              <Search size={12} className="text-[hsl(var(--muted-foreground))]" />
              <input
                ref={searchRef}
                value={filter.query}
                onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
                placeholder="Search command…"
                className="w-48 bg-transparent text-[11px] outline-none"
              />
              {filter.query && (
                <button onClick={() => setFilter((f) => ({ ...f, query: '' }))} className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
                  <X size={11} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Status:</span>
              {(['all', 'success', 'failed', 'running'] as CmdLogStatus[]).map((st) => (
                <button
                  key={st}
                  onClick={() => setFilter((f) => ({ ...f, status: st }))}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[10px] capitalize',
                    filter.status === st
                      ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]'
                      : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]',
                  )}
                >
                  {st}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Since:</span>
              {TIME_PRESETS.map(([label, ms]) => (
                <button
                  key={label}
                  onClick={() => setSince(ms)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[10px]',
                    since === ms
                      ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]'
                      : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {archiveWindow !== 'full' && (
              <button
                onClick={() => void fetchArchive('full')}
                className="ml-auto rounded-full border border-[hsl(var(--border))] px-2.5 py-0.5 text-[10px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
                title="Load the full archive (beyond the last 24h)"
              >
                Search full archive
              </button>
            )}
          </div>

          {/* Operator chips */}
          {operators.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Operators:</span>
              {operators.map((op) => {
                const active = filter.operators.has(op);
                return (
                  <button
                    key={op}
                    onClick={() => toggleIn('operators')(op)}
                    className={cn(
                      'flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px]',
                      active ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 text-[hsl(var(--foreground))]' : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]',
                    )}
                  >
                    <CircleDot size={9} style={{ color: operatorColor(op) }} />
                    {op}
                  </button>
                );
              })}
            </div>
          )}

          {/* Tool + host selects */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Tools:</span>
              {tools.map((t) => {
                const active = filter.tools.has(t);
                return (
                  <button
                    key={t}
                    onClick={() => toggleIn('tools')(t)}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-[10px] font-mono',
                      active ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 text-[hsl(var(--foreground))]' : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]',
                    )}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
            {hosts.length > 1 && (
              <div className="flex items-center gap-1">
                <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Host:</span>
                <select
                  value={filter.host}
                  onChange={(e) => setFilter((f) => ({ ...f, host: e.target.value }))}
                  className="rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-[11px] outline-none"
                >
                  <option value="all">All hosts</option>
                  {hosts.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Table */}
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center text-[hsl(var(--muted-foreground))]">
            <Terminal size={48} className="mb-4 opacity-30" />
            <p className="text-sm">No commands logged yet.</p>
            <p className="mt-1 max-w-md text-xs">
              Launch the capture agent on a Kali box, then work normally. Whitelisted commands appear here live:
            </p>
            <code className="mt-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 px-3 py-1.5 text-[11px]">
              python3 -m btct_agent install --server {origin} --token &lt;token&gt; --operator &lt;you&gt;
            </code>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
            <div className="divide-y divide-[hsl(var(--border))]">
              {rows.slice(0, MAX_RENDERED_ROWS).map((r) => (
                <LogRow key={r.id} r={r} />
              ))}
            </div>
            {rows.length > MAX_RENDERED_ROWS && (
              <div className="border-t border-[hsl(var(--border))] px-3 py-2 text-center text-[11px] text-[hsl(var(--muted-foreground))]">
                Showing {MAX_RENDERED_ROWS} of {rows.length} rows. Narrow the filters or export to CSV to see the rest.
              </div>
            )}
          </div>
        )}
      </div>

      {adding && workspaceId && (
        <AddEntryDialog
          workspaceId={workspaceId}
          operators={operators}
          hosts={hosts}
          onClose={() => setAdding(false)}
          onAdded={onManualAdded}
        />
      )}
    </div>
  );
}

// Modal form to hand-enter one command-log record as a chosen operator.
function AddEntryDialog({ workspaceId, operators, hosts, onClose, onAdded }: {
  workspaceId: string;
  operators: string[];
  hosts: string[];
  onClose: () => void;
  onAdded: (log: CommandLogEntry) => void;
}) {
  const addManual = useAuthStore((s) => s.cmdlogAddManual);
  const me = useAuthStore((s) => s.user);
  const [operator, setOperator] = useState(me?.username ?? '');
  const [command, setCommand] = useState('');
  const [tool, setTool] = useState('');
  const [host, setHost] = useState('');
  const [cwd, setCwd] = useState('');
  const [exitCode, setExitCode] = useState('');
  const [durationMs, setDurationMs] = useState('');
  const [when, setWhen] = useState(() => localDatetimeValue(Date.now()));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!operator.trim() || !command.trim()) { setErr('Operator and command are required.'); return; }
    setBusy(true); setErr(null);
    try {
      const log = await addManual({
        workspaceId,
        operator: operator.trim(),
        command: command,
        tool: tool.trim() || undefined,
        host: host.trim() || undefined,
        cwd: cwd.trim() || undefined,
        startedAt: when ? new Date(when).getTime() : undefined,
        exitCode: exitCode.trim() === '' ? undefined : Number(exitCode),
        durationMs: durationMs.trim() === '' ? undefined : Number(durationMs),
      });
      onAdded(log);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to add entry');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-xs outline-none focus:border-[hsl(var(--primary))]';
  const label = 'mb-1 block text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <Plus size={14} className="text-[hsl(var(--primary))]" /> Add command-log entry
          </h2>
          <button onClick={onClose} className="rounded-md p-1 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"><X size={14} /></button>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Operator *</label>
              <input list="cmdlog-operators" value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="who ran it" className={field} autoFocus />
              <datalist id="cmdlog-operators">
                {operators.map((op) => <option key={op} value={op} />)}
              </datalist>
            </div>
            <div>
              <label className={label}>Tool</label>
              <input value={tool} onChange={(e) => setTool(e.target.value)} placeholder="auto from command" className={field} />
            </div>
          </div>

          <div>
            <label className={label}>Command *</label>
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="nmap -sV 10.0.0.5" className={cn(field, 'font-mono')} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Host</label>
              <input list="cmdlog-hosts" value={host} onChange={(e) => setHost(e.target.value)} placeholder="kali-box" className={field} />
              <datalist id="cmdlog-hosts">
                {hosts.map((h) => <option key={h} value={h} />)}
              </datalist>
            </div>
            <div>
              <label className={label}>Working dir</label>
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/root" className={cn(field, 'font-mono')} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={label}>Started</label>
              <input type="datetime-local" step="1" value={when} onChange={(e) => setWhen(e.target.value)} className={field} />
            </div>
            <div>
              <label className={label}>Exit code</label>
              <input type="number" value={exitCode} onChange={(e) => setExitCode(e.target.value)} placeholder="blank = running" className={field} />
            </div>
            <div>
              <label className={label}>Duration (ms)</label>
              <input type="number" value={durationMs} onChange={(e) => setDurationMs(e.target.value)} placeholder="optional" className={field} />
            </div>
          </div>

          {err && <div className="text-[11px] text-[hsl(var(--status-red))]">{err}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="rounded-full border border-[hsl(var(--border))] px-3.5 py-1.5 text-[11px] hover:bg-[hsl(var(--accent))]">Cancel</button>
            <button
              onClick={() => void submit()}
              disabled={busy}
              className="rounded-full border border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 px-3.5 py-1.5 text-[11px] font-medium text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/20 disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add entry'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Format an epoch-ms into the value a <input type="datetime-local"> expects
// (local time, `YYYY-MM-DDTHH:MM:SS`).
function localDatetimeValue(ts: number): string {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 19);
}
