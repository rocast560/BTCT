// ─────────────────────────────────────────────────────────────────────────
// Whole-document search & replace panel for the Typst editor.
//
// Overlays the top of the code pane (absolute, so it never remounts the
// CodeMirror host: see invariant #3). Unlike CodeMirror's built-in Ctrl+F,
// which only decorates matches inside the rendered viewport, this scans the
// *entire* source (lib/typst-search) and lists every hit with its line and a
// context snippet, so nothing off-screen is missed. Filters: case-sensitive,
// whole-word, regex. Enter / Shift+Enter cycle matches; a click on any result
// jumps the editor to it.
// ─────────────────────────────────────────────────────────────────────────

import { useState, useMemo, useEffect, useRef, useCallback, memo } from 'react';
import {
  Search, X, ChevronUp, ChevronDown, CaseSensitive, WholeWord, Regex,
  Replace, ReplaceAll,
} from 'lucide-react';
import {
  searchAll, replaceAll, replaceOne, activeMatchIndex,
  type SearchOptions, type SearchMatch,
} from '@/lib/typst-search';

// How many result rows to render at once. `searchAll` already caps total
// matches; this keeps the DOM light on a broad query (e.g. a single letter)
// while the count still reports the true total.
const MAX_ROWS = 300;

interface Props {
  source: string;
  /** Where the caret is, so "find next" starts from the user's position. */
  caret: number;
  /** Select `[from, to)` in the editor and scroll it into view. */
  onReveal: (from: number, to: number) => void;
  /** Apply a full-source rewrite (goes through a minimal CRDT delta). */
  onReplaceSource: (next: string) => void;
  onClose: () => void;
}

/** A toggle chip for one search filter. */
const Toggle = memo(function Toggle({
  on, onClick, title, children,
}: {
  on: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`flex h-6 w-6 items-center justify-center rounded border text-[11px] ${
        on
          ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.2)] text-[hsl(var(--foreground))]'
          : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
      }`}
    >
      {children}
    </button>
  );
});

export function TypstSearchPanel({ source, caret, onReveal, onReplaceSource, onClose }: Props) {
  // Debounce the document text: `source` changes on every keystroke in the
  // editor, and without this the whole document is re-scanned per character
  // while the panel is open. Replacements still read the live `source`.
  const [debouncedSource, setDebouncedSource] = useState(source);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSource(source), 150);
    return () => clearTimeout(t);
  }, [source]);

  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [opts, setOpts] = useState<SearchOptions>({
    caseSensitive: false, wholeWord: false, regex: false,
  });
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => searchAll(debouncedSource, query, opts), [debouncedSource, query, opts]);
  const total = matches.length;
  // Regex that failed to compile (mid-typing `(`) yields zero matches: flag
  // it so we can tint the box red instead of silently showing "no results".
  const invalidRegex = opts.regex && query.length > 0 && total === 0 && !isValidRegex(query);

  // Focus the query field whenever the panel opens.
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  // When the match set changes (new query, edited source, toggled filter),
  // anchor the active match to the first one at/after the caret: "search from
  // where I am", rather than snapping to the top of the document. Manual
  // navigation (below) sets the index directly and doesn't touch the match set,
  // so a chosen match stays put until the next query/source change. `caret` is
  // the open-time position and intentionally excluded from the deps.
  useEffect(() => {
    setActive(total === 0 ? 0 : Math.max(0, activeMatchIndex(matches, caret)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  const go = useCallback((index: number) => {
    if (total === 0) return;
    const i = ((index % total) + total) % total; // wrap both directions
    setActive(i);
    const m = matches[i]!;
    onReveal(m.from, m.to);
  }, [matches, total, onReveal]);

  const next = useCallback(() => go(active + 1), [go, active]);
  const prev = useCallback(() => go(active - 1), [go, active]);

  const onQueryKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) prev(); else next();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [next, prev, onClose]);

  const doReplaceOne = useCallback(() => {
    if (total === 0) return;
    const m = matches[active]!;
    onReplaceSource(replaceOne(source, m, query, replacement, opts));
    // The source will re-flow; keep the same index so we advance to what is
    // now the next occurrence.
  }, [total, matches, active, source, query, replacement, opts, onReplaceSource]);

  const doReplaceAll = useCallback(() => {
    if (total === 0) return;
    const { text } = replaceAll(source, query, replacement, opts);
    onReplaceSource(text);
  }, [total, source, query, replacement, opts, onReplaceSource]);

  // Keep the active row scrolled into view within the results list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, matches]);

  const toggle = (k: keyof SearchOptions) => () => setOpts((o) => ({ ...o, [k]: !o[k] }));

  return (
    <div className="absolute inset-x-0 top-0 z-20 border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-lg">
      {/* Find row */}
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setShowReplace((s) => !s)}
          title={showReplace ? 'Hide replace' : 'Show replace'}
          className="flex h-6 w-4 items-center justify-center text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
        >
          {showReplace ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>

        <div className={`flex flex-1 items-center gap-1 rounded border px-1.5 ${
          invalidRegex ? 'border-[hsl(var(--status-red))]' : 'border-[hsl(var(--border))]'
        } bg-[hsl(var(--background))]`}>
          <Search size={12} className="shrink-0 text-[hsl(var(--muted-foreground))]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onQueryKey}
            placeholder="Search the whole document…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-1 font-mono text-[11px] text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))]"
          />
          <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
            {invalidRegex ? 'bad regex' : total === 0 ? 'no results' : `${active + 1}/${total}`}
          </span>
        </div>

        <Toggle on={opts.caseSensitive} onClick={toggle('caseSensitive')} title="Match case">
          <CaseSensitive size={13} />
        </Toggle>
        <Toggle on={opts.wholeWord} onClick={toggle('wholeWord')} title="Whole word">
          <WholeWord size={13} />
        </Toggle>
        <Toggle on={opts.regex} onClick={toggle('regex')} title="Regular expression">
          <Regex size={13} />
        </Toggle>

        <div className="mx-0.5 h-4 w-px bg-[hsl(var(--border))]" />

        <button type="button" onClick={prev} disabled={total === 0} title="Previous (Shift+Enter)"
          className="flex h-6 w-6 items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-40">
          <ChevronUp size={14} />
        </button>
        <button type="button" onClick={next} disabled={total === 0} title="Next (Enter)"
          className="flex h-6 w-6 items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-40">
          <ChevronDown size={14} />
        </button>
        <button type="button" onClick={onClose} title="Close (Esc)"
          className="flex h-6 w-6 items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]">
          <X size={14} />
        </button>
      </div>

      {/* Replace row */}
      {showReplace && (
        <div className="flex items-center gap-1.5 px-2 pb-1.5" style={{ paddingLeft: '30px' }}>
          <div className="flex flex-1 items-center gap-1 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-1.5">
            <Replace size={12} className="shrink-0 text-[hsl(var(--muted-foreground))]" />
            <input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}
              placeholder={opts.regex ? 'Replace with… ($1, $&)' : 'Replace with…'}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent py-1 font-mono text-[11px] text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground))]"
            />
          </div>
          <button type="button" onClick={doReplaceOne} disabled={total === 0} title="Replace this match"
            className="flex h-6 w-6 items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-40">
            <Replace size={13} />
          </button>
          <button type="button" onClick={doReplaceAll} disabled={total === 0} title="Replace all matches"
            className="flex h-6 w-6 items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-40">
            <ReplaceAll size={13} />
          </button>
        </div>
      )}

      {/* Results list: every match, document-wide, with context. */}
      {total > 0 && query.length > 0 && (
        <div ref={listRef} className="max-h-52 overflow-y-auto border-t border-[hsl(var(--border))]">
          {matches.slice(0, MAX_ROWS).map((m, i) => (
            <ResultRow key={`${m.from}-${i}`} match={m} index={i} active={i === active} onSelect={go} />
          ))}
          {total > MAX_ROWS && (
            <div className="px-3 py-1.5 text-center font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
              +{total - MAX_ROWS} more: narrow the search to see them
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Whether a query is a compilable regex (used only to tint the input). */
function isValidRegex(query: string): boolean {
  try { new RegExp(query); return true; } catch { return false; }
}

const ResultRow = memo(function ResultRow({
  match, index, active, onSelect,
}: {
  match: SearchMatch; index: number; active: boolean; onSelect: (index: number) => void;
}) {
  const [a, b] = match.inLine;
  // Trim long leading context so the match stays visible, keeping a hint that
  // text preceded it.
  const lead = match.lineText.slice(0, a);
  const shownLead = lead.length > 40 ? '…' + lead.slice(-40) : lead;
  const hit = match.lineText.slice(a, b);
  const tail = match.lineText.slice(b);

  return (
    <button
      type="button"
      data-i={index}
      onClick={() => onSelect(index)}
      className={`flex w-full items-baseline gap-2 px-2 py-1 text-left font-mono text-[11px] ${
        active ? 'bg-[hsl(var(--primary)/0.18)]' : 'hover:bg-[hsl(var(--accent))]'
      }`}
    >
      <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-[hsl(var(--muted-foreground))]">
        {match.line}
      </span>
      <span className="min-w-0 flex-1 truncate text-[hsl(var(--muted-foreground))]">
        {shownLead}
        <span className="rounded-sm bg-[hsl(var(--status-purple)/0.35)] text-[hsl(var(--foreground))]">{hit}</span>
        {tail}
      </span>
    </button>
  );
});
