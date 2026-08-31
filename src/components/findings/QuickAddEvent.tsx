// ─────────────────────────────────────────────────────────────────────────
// Quick-add a custom Attack Timeline event.
//
// Opened by a keybind (default Ctrl/⌘+Shift+E, rebindable in the Keybinds
// dialog). Fully keyboard-driven: ↑/↓ move between fields, ←/→ pick the event
// type on the type row, Enter saves, Esc closes. The event is stamped with the
// current account so the timeline can show who added it.
// ─────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Server, Wrench, Key, Shuffle, Bug, Clock, X } from 'lucide-react';
import { useAppStore } from '@/stores';
import { useAuthStore } from '@/auth/auth-store';
import type { NodeType } from '@/types';
import { Portal } from '@/components/ui/Portal';

const TYPES: { kind: NodeType; label: string; Icon: typeof Server; color: string }[] = [
  { kind: 'host', label: 'Host', Icon: Server, color: 'text-sky-300' },
  { kind: 'service', label: 'Service', Icon: Wrench, color: 'text-teal-300' },
  { kind: 'credential', label: 'Credential', Icon: Key, color: 'text-amber-300' },
  { kind: 'pivot', label: 'Pivot', Icon: Shuffle, color: 'text-fuchsia-300' },
  { kind: 'finding', label: 'Finding', Icon: Bug, color: 'text-red-300' },
];

/** `YYYY-MM-DDTHH:mm` in local time, for the datetime-local input default. */
function localDatetimeValue(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Row order for ↑/↓ navigation.
type Row = 'type' | 'title' | 'details' | 'when' | 'save';
const ROWS: Row[] = ['type', 'title', 'details', 'when', 'save'];

export function QuickAddEvent() {
  const open = useAppStore((s) => s.quickAddOpen);
  const setOpen = useAppStore((s) => s.setQuickAddOpen);
  const createTimelineEvent = useAppStore((s) => s.createTimelineEvent);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const user = useAuthStore((s) => s.user);

  const [typeIdx, setTypeIdx] = useState(0);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [when, setWhen] = useState('');
  const [row, setRow] = useState<Row>('title');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const detailsRef = useRef<HTMLInputElement>(null);
  const whenRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const typeRowRef = useRef<HTMLDivElement>(null);

  // Reset every time the popup opens, defaulting the time to now.
  useEffect(() => {
    if (!open) return;
    setTypeIdx(0);
    setTitle('');
    setDetails('');
    setWhen(localDatetimeValue(Date.now()));
    setRow('title');
    setError(null);
  }, [open]);

  // Move focus to whatever row is active.
  useEffect(() => {
    if (!open) return;
    const map: Record<Row, HTMLElement | null> = {
      type: typeRowRef.current,
      title: titleRef.current,
      details: detailsRef.current,
      when: whenRef.current,
      save: saveRef.current,
    };
    map[row]?.focus();
  }, [row, open]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  const submit = useCallback(async () => {
    if (!activeWorkspaceId) { setError('Open a workspace first.'); return; }
    if (!title.trim()) { setError('Give the event a title.'); setRow('title'); return; }
    const ts = when ? new Date(when).getTime() : Date.now();
    if (!Number.isFinite(ts)) { setError('That date/time is not valid.'); setRow('when'); return; }
    setSaving(true);
    setError(null);
    try {
      await createTimelineEvent({
        kind: TYPES[typeIdx]!.kind,
        title: title.trim(),
        details: details.trim(),
        timestamp: ts,
        createdBy: user?.id ?? null,
        createdByName: user?.username ?? 'unknown',
      });
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the event.');
    } finally {
      setSaving(false);
    }
  }, [activeWorkspaceId, title, when, details, typeIdx, user, createTimelineEvent, close]);

  const moveRow = useCallback((dir: 1 | -1) => {
    setRow((r) => {
      const i = ROWS.indexOf(r);
      return ROWS[Math.min(Math.max(i + dir, 0), ROWS.length - 1)]!;
    });
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    // Ctrl/⌘+Enter always saves, from any field.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveRow(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveRow(-1); return; }
    if (row === 'type' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      setTypeIdx((i) => (i + (e.key === 'ArrowRight' ? 1 : TYPES.length - 1)) % TYPES.length);
      return;
    }
    if (e.key === 'Enter' && row === 'save') { e.preventDefault(); void submit(); return; }
    // Enter on a text field advances to the next row (Notion-quick-add feel).
    if (e.key === 'Enter' && (row === 'title' || row === 'details' || row === 'when')) {
      e.preventDefault();
      moveRow(1);
    }
  }, [row, close, submit, moveRow]);

  const selected = useMemo(() => TYPES[typeIdx]!, [typeIdx]);

  if (!open) return null;

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[120] flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
        onClick={close}
        onKeyDown={onKeyDown}
      >
        <div
          className="w-full max-w-lg overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-3">
            <div className="flex items-center gap-2">
              <Clock size={15} className="text-[hsl(var(--status-amber))]" />
              <span className="text-[11px] font-bold uppercase tracking-widest">Add timeline event</span>
            </div>
            <button onClick={close} className="rounded-md p-1 hover:bg-[hsl(var(--accent))]" title="Close (Esc)">
              <X size={14} />
            </button>
          </div>

          <div className="space-y-3 p-4">
            {/* Type: ←/→ to change while this row is focused */}
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                Type <span className="normal-case opacity-60">(←/→)</span>
              </label>
              <div
                ref={typeRowRef}
                tabIndex={0}
                role="radiogroup"
                aria-label="Event type"
                className={`flex flex-wrap gap-1.5 rounded-lg border p-1.5 outline-none ${
                  row === 'type' ? 'border-[hsl(var(--primary))] ring-2 ring-[hsl(var(--primary))]/30' : 'border-[hsl(var(--border))]'
                }`}
                onFocus={() => setRow('type')}
              >
                {TYPES.map((t, i) => {
                  const active = i === typeIdx;
                  const Icon = t.Icon;
                  return (
                    <button
                      key={t.kind}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      tabIndex={-1}
                      onClick={() => setTypeIdx(i)}
                      className={`flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] ${
                        active
                          ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/15 text-[hsl(var(--foreground))]'
                          : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
                      }`}
                    >
                      <Icon size={11} className={active ? t.color : ''} />
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Title */}
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Title</label>
              <input
                ref={titleRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onFocus={() => setRow('title')}
                placeholder={`e.g. ${selected.label === 'Host' ? 'Compromised DC01' : selected.label + ' step'}`}
                className="w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
              />
            </div>

            {/* Details */}
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Details</label>
              <input
                ref={detailsRef}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                onFocus={() => setRow('details')}
                placeholder="What happened, IP, command, etc. (optional)"
                className="w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
              />
            </div>

            {/* When */}
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Date &amp; time</label>
              <input
                ref={whenRef}
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                onFocus={() => setRow('when')}
                className="w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
              />
            </div>

            {error && (
              <div className="rounded-lg border border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-3 py-1.5 text-[11px] text-[hsl(var(--status-red))]">
                {error}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-[hsl(var(--border))] px-4 py-3">
            <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
              ↑/↓ move · ←/→ type · Enter next · ⌘/Ctrl+Enter save · Esc close
            </span>
            <button
              ref={saveRef}
              onClick={() => void submit()}
              onFocus={() => setRow('save')}
              disabled={saving}
              className={`rounded-lg border px-3 py-1.5 text-xs ${
                row === 'save'
                  ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                  : 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/90 text-[hsl(var(--primary-foreground))]'
              } hover:opacity-90 disabled:opacity-50`}
            >
              {saving ? 'Adding…' : 'Add event'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
