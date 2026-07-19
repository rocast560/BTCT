// ─────────────────────────────────────────────────────────────────────────
// Mapping a click in the rendered preview back to a position in the source.
//
// typst.ts's SVG output carries a hidden text-selection layer: every rendered
// run of text appears verbatim inside a `<foreignObject><div class="tsel">`.
// That gives us the literal string the user clicked on, and we find it in the
// source by text search.
//
// Why not the "proper" route: the renderer exposes `session.getSourceLoc()`,
// which resolves an element path to a Typst span. But spans are only embedded
// when the compiler has debug info attached, and typst.ts only exposes that
// switch on its incremental-server API — a rendered document from the normal
// compile path contains a single `data-span` for the whole page, which is
// useless for this. Text search needs no compiler cooperation and degrades
// gracefully.
//
// The trade-off is that a rendered string doesn't always appear literally in
// the source: `= Heading` renders as `Heading`, `--` renders as an en dash,
// and markup can split a sentence across runs. The matching below handles the
// common transformations and falls back progressively rather than failing.
//
// Pure and DOM-free; the click handling that feeds it lives in TypstPreview.
// ─────────────────────────────────────────────────────────────────────────

export interface SourceRange {
  from: number;
  to: number;
}

/**
 * Canonicalize typographic variants so rendered text can be matched against
 * the source that produced it.
 *
 * Every rule here is strictly **one character in, one character out**. The
 * search runs on the normalized string but reports offsets into the original,
 * so any rule that changed the length would silently skew every result.
 * (That's why `--` → en dash isn't handled here — it's 2:1. The fallbacks
 * below cover it instead.)
 */
export function normalizeForMatch(text: string): string {
  let out = '';
  for (const ch of text) {
    switch (ch) {
      // Smart quotes — Typst applies these automatically.
      case '‘': case '’': case '‚': case '‛':
        out += "'"; break;
      case '“': case '”': case '„': case '‟':
        out += '"'; break;
      // Spaces of every width.
      case ' ': case ' ': case ' ': case ' ': case ' ':
      case ' ': case ' ': case ' ': case ' ': case ' ':
      case ' ': case ' ': case '　':
        out += ' '; break;
      // Dashes and the non-breaking hyphen.
      case '‐': case '‑': case '‒': case '–': case '—':
      case '−':
        out += '-'; break;
      default:
        out += ch;
    }
  }
  return out;
}

/** All indices at which `needle` occurs in `haystack`. */
function allIndicesOf(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return out;
}

/**
 * Pick the `occurrence`-th hit, clamping rather than failing.
 *
 * Render order and source order can diverge (a floating figure, a footnote),
 * so an out-of-range index means our count was off — not that there's no
 * match. Landing on the last plausible hit is far more useful than doing
 * nothing.
 */
function pickIndex(indices: number[], occurrence: number): number | null {
  if (indices.length === 0) return null;
  const i = Math.min(Math.max(occurrence, 0), indices.length - 1);
  return indices[i]!;
}

/** The longest word in `text`, used as a last-resort anchor. */
function longestWord(text: string): string | null {
  const words = text.split(/[^\p{L}\p{N}_-]+/u).filter((w) => w.length >= 4);
  if (words.length === 0) return null;
  return words.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Locate rendered `text` in `source`, returning the range to select.
 *
 * Tries progressively looser strategies, because rendered text is not always
 * a literal substring of what produced it:
 *
 *   1. the whole string,
 *   2. whitespace-collapsed (markup can introduce line breaks mid-sentence),
 *   3. the first clause, cut at a dash or punctuation Typst may have rewritten,
 *   4. the longest single word — which survives almost any transformation.
 *
 * Returns null only when nothing recognizable is found, so the caller can
 * leave the cursor where it is rather than jumping somewhere wrong.
 */
export function findSourceRange(
  source: string,
  text: string,
  occurrence = 0,
): SourceRange | null {
  const haystack = normalizeForMatch(source);
  const needle = normalizeForMatch(text).trim();
  if (needle.length < 2) return null;

  // 1. Exact.
  let at = pickIndex(allIndicesOf(haystack, needle), occurrence);
  if (at !== null) return { from: at, to: at + needle.length };

  // 2. Collapse runs of whitespace in the needle and retry against a source
  //    whose whitespace has been collapsed the same way. Both transforms are
  //    length-preserving per character, so offsets stay meaningful only if we
  //    search the *original* haystack — so instead, split on whitespace and
  //    anchor on the longest contiguous fragment.
  const fragments = needle.split(/\s+/).filter((f) => f.length >= 3);
  if (fragments.length > 1) {
    const anchor = fragments.reduce((a, b) => (b.length > a.length ? b : a));
    at = pickIndex(allIndicesOf(haystack, anchor), occurrence);
    if (at !== null) return { from: at, to: at + anchor.length };
  }

  // 3. First clause, before any character Typst commonly rewrites.
  const clause = needle.split(/[–—\-—–,;:]/)[0]?.trim() ?? '';
  if (clause.length >= 4) {
    at = pickIndex(allIndicesOf(haystack, clause), occurrence);
    if (at !== null) return { from: at, to: at + clause.length };
  }

  // 4. Longest word.
  const word = longestWord(needle);
  if (word) {
    at = pickIndex(allIndicesOf(haystack, word), occurrence);
    if (at !== null) return { from: at, to: at + word.length };
  }

  return null;
}

/**
 * Which occurrence of `text` this is, among `allTexts` in render order.
 *
 * Repeated strings ("Severity", a recurring table header) would otherwise all
 * jump to the first one in the source. Counting identical earlier runs lets
 * the Nth rendered instance select the Nth source instance.
 */
export function occurrenceIndex(allTexts: readonly string[], index: number): number {
  const target = normalizeForMatch(allTexts[index] ?? '').trim();
  let n = 0;
  for (let i = 0; i < index; i++) {
    if (normalizeForMatch(allTexts[i] ?? '').trim() === target) n++;
  }
  return n;
}
