// ─────────────────────────────────────────────────────────────────────────
// Whole-document search over the Typst source.
//
// CodeMirror's built-in Ctrl+F only decorates matches inside the rendered
// viewport, so in a long report it *looks* like search sees only what's on
// screen. This module scans the entire source string once and returns every
// match with the line/column context needed to list them all: the editor
// then jumps to whichever the user picks. Pure and DOM-free; the panel that
// drives it lives in components/typst/TypstSearchPanel.
// ─────────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** Case-sensitive matching (default: insensitive). */
  caseSensitive: boolean;
  /** Match only at word boundaries. */
  wholeWord: boolean;
  /** Treat the query as a JS regular expression rather than a literal. */
  regex: boolean;
}

export interface SearchMatch {
  /** Absolute offsets into the source, ready for `revealTypstRange`. */
  from: number;
  to: number;
  /** 1-based line number (for display). */
  line: number;
  /** 0-based column within the line. */
  column: number;
  /** The full text of the line the match starts on (trimmed of the newline). */
  lineText: string;
  /** `[start, end)` of the match *within* `lineText`, for highlighting. */
  inLine: [number, number];
}

/** Hard ceiling so a pathological query (e.g. `.` over a huge doc) can't hang. */
export const MAX_MATCHES = 5000;

/** Escape a literal so it can be embedded safely in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the matcher for a query, or `null` when it can't match anything
 * (empty query, or an invalid regex the user is mid-typing). Callers treat
 * `null` as "no results" rather than an error, so a half-written `(` doesn't
 * throw.
 *
 * The returned RegExp is always global so `exec` walks the whole source.
 */
export function compileMatcher(query: string, opts: SearchOptions): RegExp | null {
  if (!query) return null;
  let body = opts.regex ? query : escapeRegExp(query);
  // Lookarounds rather than \b: \b needs a word character on one side, so
  // a query that starts or ends with punctuation ("#set", "foo()") never
  // matched as a whole word.
  if (opts.wholeWord) body = `(?<!\\w)(?:${body})(?!\\w)`;
  let flags = 'g';
  if (!opts.caseSensitive) flags += 'i';
  try {
    return new RegExp(body, flags);
  } catch {
    return null; // invalid regex mid-edit: surface as zero matches
  }
}

/** Precomputed line-start offsets, so a match offset → line/column is O(log n). */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Largest index `i` with `starts[i] <= offset` (which line the offset is on). */
function lineIndexOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Every match of `query` across the whole `source`, in document order.
 *
 * Guards against zero-length matches (an empty-alternation regex like `a*`
 * would otherwise loop forever) by advancing one character past any empty hit.
 * Capped at `MAX_MATCHES`.
 */
export function searchAll(source: string, query: string, opts: SearchOptions): SearchMatch[] {
  const re = compileMatcher(query, opts);
  if (!re) return [];

  const starts = lineStarts(source);
  const out: SearchMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const from = m.index;
    const to = from + m[0].length;

    const li = lineIndexOf(starts, from);
    const lineFrom = starts[li]!;
    const lineEnd = li + 1 < starts.length ? starts[li + 1]! - 1 : source.length;
    const lineText = source.slice(lineFrom, lineEnd);
    const column = from - lineFrom;

    out.push({
      from,
      to,
      line: li + 1,
      column,
      lineText,
      // Clamp the in-line end so a match spanning past the line break (a
      // multi-line regex hit) still highlights sanely within this line.
      inLine: [column, Math.min(to, lineEnd) - lineFrom],
    });

    if (out.length >= MAX_MATCHES) break;
    // Never let a zero-width match pin the cursor in place.
    if (to === from) re.lastIndex++;
  }
  return out;
}

/**
 * Index of the match to treat as "current" given the caret/selection anchor.
 *
 * Picks the first match at or after `anchor` so pressing Enter after a click
 * continues from where the user is, wrapping to 0 when the anchor is past the
 * last match. Returns -1 for an empty list.
 */
export function activeMatchIndex(matches: readonly SearchMatch[], anchor: number): number {
  if (matches.length === 0) return -1;
  for (let i = 0; i < matches.length; i++) {
    if (matches[i]!.from >= anchor) return i;
  }
  return 0;
}

// Literal replacements must not have `$1`/`$&` interpreted, so any `$` in the
// text is doubled before it reaches the native `String.prototype.replace`.
function literalReplacement(replacement: string): string {
  return replacement.replace(/\$/g, '$$$$');
}

/**
 * Replace exactly the given match with `replacement`, returning the new full
 * source. In regex mode `$1`/`$&`/`$$` in the replacement expand against this
 * match's captures (native `String.replace` semantics); in literal mode a `$`
 * stays a literal `$`.
 */
export function replaceOne(
  source: string,
  match: SearchMatch,
  query: string,
  replacement: string,
  opts: SearchOptions,
): string {
  if (!opts.regex) {
    return source.slice(0, match.from) + replacement + source.slice(match.to);
  }
  const re = compileMatcher(query, opts);
  if (!re) return source;
  // A sticky clone anchored at the match runs against the WHOLE source, so a
  // pattern whose match depends on its surroundings (lookarounds, ^, $, whole
  // word) still matches; re-running it on the isolated slice did not.
  const sticky = new RegExp(re.source, re.flags.replace('g', '') + 'y');
  sticky.lastIndex = match.from;
  const m = sticky.exec(source);
  if (!m || m.index !== match.from || m[0].length !== match.to - match.from) return source;
  // String.replace honours lastIndex on a sticky regex, so this replaces
  // exactly this occurrence and still expands $1 / $& from the full-source
  // match.
  sticky.lastIndex = match.from;
  return source.replace(sticky, replacement);
}

/** Count matches without materializing them (bounded by `MAX_MATCHES`). */
function countMatches(source: string, re: RegExp): number {
  re.lastIndex = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    count++;
    if (count >= MAX_MATCHES) break;
    if (m[0].length === 0) re.lastIndex++;
  }
  return count;
}

/**
 * Replace every match in the document, returning the rewritten source and how
 * many replacements were made. The native global regex does the substitution
 * in one pass, so regex replacements (`$1`, `$&`, …) work exactly as in
 * `String.prototype.replace`.
 */
export function replaceAll(
  source: string,
  query: string,
  replacement: string,
  opts: SearchOptions,
): { text: string; count: number } {
  const re = compileMatcher(query, opts);
  if (!re) return { text: source, count: 0 };
  const count = countMatches(source, re);
  re.lastIndex = 0;
  const text = source.replace(re, opts.regex ? replacement : literalReplacement(replacement));
  return { text, count };
}
