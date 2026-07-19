import { describe, it, expect } from 'vitest';
import { findSourceRange, normalizeForMatch, occurrenceIndex } from '@/lib/typst-source-map';

const SRC = `#set page(margin: 1.5cm)
#set heading(numbering: "1.1")

= Executive Summary

The assessment identified three critical findings.

== Authentication bypass

An attacker can reach /admin without credentials.

= Findings

#table(
  [*Severity*], [High],
)

Some text with "smart quotes" and a range 10--20 here.

== Authentication bypass

A second section with the same heading text.
`;

const textAt = (r: { from: number; to: number } | null) => (r ? SRC.slice(r.from, r.to) : null);

describe('normalizeForMatch', () => {
  it('is length-preserving for every rule', () => {
    // Offsets are reported into the original string, so any rule that changed
    // the length would silently skew every result.
    for (const s of ['“hello”', 'a b', 'x–y', 'it’s', 'plain', '—‑']) {
      expect(normalizeForMatch(s)).toHaveLength(s.length);
    }
  });

  it('folds smart quotes to straight ones', () => {
    expect(normalizeForMatch('“x”')).toBe('"x"');
    expect(normalizeForMatch('it’s')).toBe("it's");
  });

  it('folds exotic spaces and dashes', () => {
    expect(normalizeForMatch('a b')).toBe('a b');
    expect(normalizeForMatch('a–b')).toBe('a-b');
  });
});

describe('findSourceRange', () => {
  it('finds a heading, excluding its markup prefix', () => {
    const r = findSourceRange(SRC, 'Executive Summary', 0);
    expect(textAt(r)).toBe('Executive Summary');
    expect(SRC[r!.from - 2]).toBe('='); // the `= ` marker sits just before
  });

  it('finds a full sentence', () => {
    const r = findSourceRange(SRC, 'The assessment identified three critical findings.', 0);
    expect(textAt(r)).toContain('The assessment identified');
  });

  it('finds a table cell', () => {
    expect(textAt(findSourceRange(SRC, 'Severity', 0))).toBe('Severity');
  });

  it('matches through smart quotes and an en dash via fallback', () => {
    // Typst renders "..." as curly quotes and `--` as an en dash, neither of
    // which appears literally in the source.
    const r = findSourceRange(SRC, 'Some text with “smart quotes” and a range 10–20 here.', 0);
    expect(r).not.toBeNull();
  });

  it('uses the occurrence index to disambiguate repeated text', () => {
    const first = findSourceRange(SRC, 'Authentication bypass', 0)!;
    const second = findSourceRange(SRC, 'Authentication bypass', 1)!;
    expect(textAt(first)).toBe('Authentication bypass');
    expect(second.from).toBeGreaterThan(first.from);
  });

  it('clamps an out-of-range occurrence instead of failing', () => {
    // Render order and source order can diverge; landing on the last
    // plausible hit beats doing nothing.
    const second = findSourceRange(SRC, 'Authentication bypass', 1)!;
    expect(findSourceRange(SRC, 'Authentication bypass', 99)!.from).toBe(second.from);
  });

  it('returns null rather than guessing when the text is absent', () => {
    expect(findSourceRange(SRC, 'zzz nonexistent phrase qqq', 0)).toBeNull();
  });

  it('ignores a needle too short to be meaningful', () => {
    expect(findSourceRange(SRC, 'a', 0)).toBeNull();
    expect(findSourceRange(SRC, '', 0)).toBeNull();
  });

  it('falls back to the longest word when the phrase was transformed', () => {
    const r = findSourceRange(SRC, 'credentials — entirely absent', 0);
    expect(textAt(r)).toBe('credentials');
  });
});

describe('occurrenceIndex', () => {
  const texts = ['Alpha', 'Beta', 'Alpha', 'Gamma', 'Alpha'];

  it('counts identical earlier runs', () => {
    expect(occurrenceIndex(texts, 0)).toBe(0);
    expect(occurrenceIndex(texts, 2)).toBe(1);
    expect(occurrenceIndex(texts, 4)).toBe(2);
  });

  it('ignores runs with different text', () => {
    expect(occurrenceIndex(texts, 3)).toBe(0);
  });

  it('treats typographic variants as the same run', () => {
    expect(occurrenceIndex(['“x”', '"x"'], 1)).toBe(1);
  });
});
