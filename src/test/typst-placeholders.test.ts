import { describe, it, expect } from 'vitest';
import {
  ensureHelper,
  findScreenshotSlots,
  inspectHelper,
  newSlotSnippet,
  parseStringLiteral,
  setSlotPath,
  toStringLiteral,
} from '@/lib/typst-placeholders';

/** The original, path-unaware helper: what existing documents contain. */
const LEGACY_HELPER = `#let image-placeholder(caption, height: 2.2in) = figure(
  block(
    width: 90%,
    height: height,
    fill: luma(245),
    stroke: 1pt + luma(180),
    radius: 4pt,
    align(center + horizon,
      text(fill: luma(120), style: "italic", size: 11pt)[
        \\[ {{TODO: Insert screenshot here}} \\]
      ],
    ),
  ),
  caption: caption,
)`;

const DOC = `#set page(margin: 1.5cm)
#set text(size: 11pt)

${LEGACY_HELPER}

= Findings

#image-placeholder("Login bypass")

Some prose here.

#image-placeholder("Shell on host, with a \\"quoted\\" caption", height: 3in)

#image-placeholder("Already placed", path: "/assets/old.png")
`;

describe('string literals', () => {
  it('round-trips a plain value', () => {
    expect(parseStringLiteral(toStringLiteral('hello'))).toBe('hello');
  });

  it('round-trips quotes and backslashes', () => {
    const nasty = 'a "quoted" \\ backslash';
    expect(parseStringLiteral(toStringLiteral(nasty))).toBe(nasty);
  });

  it('rejects a non-literal', () => {
    expect(parseStringLiteral('someVariable')).toBeNull();
    expect(parseStringLiteral('none')).toBeNull();
  });
});

describe('findScreenshotSlots', () => {
  const slots = findScreenshotSlots(DOC);

  it('finds every call site', () => {
    expect(slots).toHaveLength(3);
  });

  it('does not mistake the #let definition for a slot', () => {
    for (const s of slots) expect(DOC.slice(s.start, s.start + 5)).not.toBe('#let ');
  });

  it('parses captions, including escaped quotes', () => {
    expect(slots[0]!.caption).toBe('Login bypass');
    expect(slots[1]!.caption).toBe('Shell on host, with a "quoted" caption');
  });

  it('distinguishes empty slots from filled ones', () => {
    expect(slots[0]!.path).toBeNull();
    expect(slots[2]!.path).toBe('/assets/old.png');
  });

  it('reports ascending line numbers', () => {
    expect(slots[1]!.line).toBeGreaterThan(slots[0]!.line);
  });

  it('ignores a commented-out call', () => {
    const found = findScreenshotSlots('// #image-placeholder("nope")\n#image-placeholder("yes")\n');
    expect(found.map((s) => s.caption)).toEqual(['yes']);
  });

  it('tolerates unbalanced source mid-edit rather than throwing', () => {
    expect(() => findScreenshotSlots('#image-placeholder("half typed"')).not.toThrow();
    expect(findScreenshotSlots('#image-placeholder("half typed"')).toHaveLength(0);
  });

  it('handles nested parens inside arguments', () => {
    const found = findScreenshotSlots('#image-placeholder("cap (parens)", height: calc.max(2in, 3in))\n');
    expect(found).toHaveLength(1);
    expect(found[0]!.caption).toBe('cap (parens)');
  });
});

describe('setSlotPath', () => {
  const slots = findScreenshotSlots(DOC);

  it('assigns a path to an empty slot', () => {
    const next = setSlotPath(DOC, slots[0]!, '/assets/shot.png');
    expect(findScreenshotSlots(next)[0]!.path).toBe('/assets/shot.png');
  });

  it('leaves the other slots untouched', () => {
    const next = findScreenshotSlots(setSlotPath(DOC, slots[0]!, '/assets/shot.png'));
    expect(next).toHaveLength(3);
    expect(next[1]!.caption).toBe(slots[1]!.caption);
    expect(next[2]!.path).toBe('/assets/old.png');
  });

  it("preserves the author's other arguments", () => {
    const next = setSlotPath(DOC, slots[1]!, '/assets/b.png');
    expect(next).toContain('height: 3in');
    expect(findScreenshotSlots(next)[1]!.path).toBe('/assets/b.png');
  });

  it('replaces rather than duplicates an existing path', () => {
    const next = setSlotPath(DOC, slots[2]!, '/assets/new.png');
    expect(findScreenshotSlots(next)[2]!.path).toBe('/assets/new.png');
    expect(next.match(/path:/g)).toHaveLength(1);
  });

  it('clears a path without leaving a dangling comma', () => {
    const next = setSlotPath(DOC, slots[2]!, null);
    const line = next.split('\n').find((l) => l.includes('Already placed'))!;
    expect(findScreenshotSlots(next)[2]!.path).toBeNull();
    expect(findScreenshotSlots(next)[2]!.caption).toBe('Already placed');
    expect(line).not.toMatch(/,\s*\)/);
  });

  it('escapes a path containing a quote', () => {
    const next = setSlotPath(DOC, slots[0]!, '/assets/we"ird.png');
    expect(findScreenshotSlots(next)[0]!.path).toBe('/assets/we"ird.png');
  });
});

describe('ensureHelper', () => {
  it('detects the legacy helper as path-unaware', () => {
    const state = inspectHelper(DOC);
    expect(state.defined).toBe(true);
    expect(state.supportsPath).toBe(false);
  });

  it('upgrades the legacy helper in place, preserving the document', () => {
    const { source, changed } = ensureHelper(DOC);
    expect(changed).toBe(true);
    expect(inspectHelper(source).supportsPath).toBe(true);
    expect(source).toContain('= Findings');
    expect(source).toContain('Some prose here.');
    expect(findScreenshotSlots(source)).toHaveLength(3);
  });

  it('does not duplicate the helper when upgrading', () => {
    const { source } = ensureHelper(DOC);
    expect(source.match(/#let image-placeholder\(/g)).toHaveLength(1);
  });

  it('is idempotent', () => {
    const once = ensureHelper(DOC).source;
    expect(ensureHelper(once).changed).toBe(false);
  });

  it('allows placing after an upgrade', () => {
    const upgraded = ensureHelper(DOC).source;
    const slot = findScreenshotSlots(upgraded)[0]!;
    const placed = setSlotPath(upgraded, slot, '/assets/z.png');
    expect(findScreenshotSlots(placed)[0]!.path).toBe('/assets/z.png');
  });

  it('inserts a missing helper after the #set preamble', () => {
    const bare = '#set page(margin: 1cm)\n#set text(size: 11pt)\n\n= Report\n\nBody.\n';
    const { source, changed } = ensureHelper(bare);
    expect(changed).toBe(true);
    expect(inspectHelper(source).supportsPath).toBe(true);
    expect(source.indexOf('#let image-placeholder')).toBeGreaterThan(source.indexOf('#set text'));
    expect(source).toContain('= Report');
    expect(source).toContain('Body.');
  });
});

describe('newSlotSnippet', () => {
  it('produces a slot the scanner can find', () => {
    const doc = ensureHelper('').source + newSlotSnippet('New figure');
    const slots = findScreenshotSlots(doc);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.caption).toBe('New figure');
    expect(slots[0]!.path).toBeNull();
  });

  it('escapes a caption containing a quote', () => {
    const doc = ensureHelper('').source + newSlotSnippet('The "admin" panel');
    expect(findScreenshotSlots(doc)[0]!.caption).toBe('The "admin" panel');
  });
});
