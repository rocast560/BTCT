import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { createLeaf, findLeafContainingTab, moveTab } from '@/lib/pane-layout';
import type { SplitPane } from '@/types';
import { changedUsersBetween } from '../../server/history-diff.mjs';
import { normalizeBackupConfig } from '../../server/backup-format.mjs';
import { dayLabel } from '@/lib/page-history';
import { compileMatcher, replaceOne, searchAll, type SearchOptions } from '@/lib/typst-search';
import { ensureHelper, findScreenshotSlots, parseStringLiteral, setSlotPath } from '@/lib/typst-placeholders';
import { designRegions } from '@/lib/typst-source-map';
import { figureWidthPt } from '@/lib/typst-geometry';
import { fitCropToBox, zoomCrop, MAX_VISIBLE_FRACTION } from '@/lib/crop-math';

// Regression tests for the defects the 2026-08-28 audit's test-breaker found
// (docs/perf-bug-audit-2026-08-28.md).

describe('moveTab never strands a tab', () => {
  it('splitting off the sole tab of its own pane keeps the tab', () => {
    const a = createLeaf(['t1'], 't1');
    const b = createLeaf(['t2'], 't2');
    const split: SplitPane = { type: 'split', id: 's', direction: 'horizontal', children: [a, b], ratio: 0.5 };
    const out = moveTab(split, 't1', a.id, 'right');
    expect(findLeafContainingTab(out, 't1')).not.toBeNull();
    expect(findLeafContainingTab(out, 't2')).not.toBeNull();
  });

  it('dropping the sole tab onto the centre of its own pane is a no-op', () => {
    const a = createLeaf(['t1'], 't1');
    const b = createLeaf(['t2'], 't2');
    const split: SplitPane = { type: 'split', id: 's', direction: 'horizontal', children: [a, b], ratio: 0.5 };
    expect(moveTab(split, 't2', b.id, 'center')).toBe(split);
  });

  it('an unknown target pane leaves the layout untouched', () => {
    const a = createLeaf(['t1', 't2'], 't1');
    expect(moveTab(a, 't1', 'ghost', 'center')).toBe(a);
  });

  it('an edge drop on a single root leaf leaves no empty pane behind', () => {
    const a = createLeaf(['t1'], 't1');
    const out = moveTab(a, 't1', a.id, 'left');
    expect(out.type).toBe('leaf');
    expect(findLeafContainingTab(out, 't1')).not.toBeNull();
  });
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function link(from: Y.Doc, ...to: Y.Doc[]) {
  from.on('update', (u: Uint8Array) => { for (const d of to) Y.applyUpdate(d, u); });
}

describe('changedUsersBetween with adjacent deletions', () => {
  it('credits a second deletion that Yjs merged into an earlier range', async () => {
    const twin = new Y.Doc({ gc: false });
    const a = new Y.Doc();
    const b = new Y.Doc();
    link(a, twin, b);
    link(b, twin, a);
    new Y.PermanentUserData(a).setUserMapping(a, a.clientID, '1');
    new Y.PermanentUserData(b).setUserMapping(b, b.clientID, '2');
    const pud = new Y.PermanentUserData(twin);
    a.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'hello world');
      p.insert(0, [t]);
      a.getXmlFragment('prosemirror').insert(0, [p]);
    });
    const s1 = Y.snapshot(twin);
    b.transact(() => { ((b.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(0, 6); });
    await settle();
    const s2 = Y.snapshot(twin);
    expect(changedUsersBetween(Y, twin, 'prosemirror', s1, s2, pud)).toEqual({ changed: true, users: ['2'] });
    a.transact(() => { ((a.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(0, 2); });
    await settle();
    const s3 = Y.snapshot(twin);
    const d = changedUsersBetween(Y, twin, 'prosemirror', s2, s3, pud);
    expect(d.changed).toBe(true);
    expect(d.users).toEqual(['1']);
  });
});

describe('backup config', () => {
  it('a blank interval means the default, not one minute', () => {
    expect(normalizeBackupConfig({ fullIntervalMin: '' }).fullIntervalMin).toBe(60);
    expect(normalizeBackupConfig({ fullIntervalMin: null }).fullIntervalMin).toBe(60);
    expect(normalizeBackupConfig({ fullIntervalMin: '15' }).fullIntervalMin).toBe(15);
  });
});

describe('dayLabel', () => {
  it('uses calendar days for Yesterday', () => {
    const now = new Date(2026, 7, 28, 0, 30).getTime();
    const yesterdayNoon = new Date(2026, 7, 27, 12, 0).getTime();
    const twoDaysAgo = new Date(2026, 7, 26, 12, 0).getTime();
    expect(dayLabel(yesterdayNoon, now)).toBe('Yesterday');
    expect(dayLabel(twoDaysAgo, now)).not.toBe('Yesterday');
  });
});

const opts = (o: Partial<SearchOptions> = {}): SearchOptions => ({ caseSensitive: false, wholeWord: false, regex: false, ...o });

describe('typst search', () => {
  it('whole-word matches a directive that starts with punctuation', () => {
    const src = '#set page(paper: "a4")\n#set text(size: 11pt)\n';
    expect(searchAll(src, '#set', opts({ wholeWord: true })).length).toBe(2);
    expect(compileMatcher('foo', opts({ wholeWord: true }))?.test('foobar')).toBe(false);
  });

  it('replaceOne honours context-dependent regexes', () => {
    const src = 'foo bar foobar';
    const behind = '(?<=foo)bar';
    const ms = searchAll(src, behind, opts({ regex: true }));
    expect(ms.length).toBe(1);
    expect(replaceOne(src, ms[0]!, behind, 'X', opts({ regex: true }))).toBe('foo bar fooX');
    const ahead = 'foo(?=bar)';
    const ms2 = searchAll(src, ahead, opts({ regex: true }));
    expect(replaceOne(src, ms2[0]!, ahead, 'X', opts({ regex: true }))).toBe('foo bar Xbar');
  });

  it('literal replacement keeps $ literal', () => {
    const src = 'price: 5';
    const ms = searchAll(src, '5', opts());
    expect(replaceOne(src, ms[0]!, '5', '$&$1', opts())).toBe('price: $&$1');
  });
});

describe('typst placeholders', () => {
  it('a trailing comma in the call never becomes ",,"', () => {
    const multi = '#image-placeholder(\n  "Auth bypass",\n)\n';
    const out = setSlotPath(multi, findScreenshotSlots(multi)[0]!, '/assets/x.png');
    expect(out).not.toMatch(/,\s*,/);
    expect(findScreenshotSlots(out)[0]?.path).toBe('/assets/x.png');
    const single = '#image-placeholder("cap",)';
    expect(setSlotPath(single, findScreenshotSlots(single)[0]!, '/assets/x.png')).not.toContain(',,');
  });

  it('the helper lands after a multi-line #set page(...)', () => {
    const src = '#set page(\n  paper: "a4",\n  header: [Confidential],\n)\n#set text(font: "Inter")\n\n= Report\n\n#image-placeholder("Cap")\n';
    const { source } = ensureHelper(src);
    const pageClose = source.indexOf('\n)\n', source.indexOf('#set page('));
    expect(source.indexOf('#let image-placeholder(')).toBeGreaterThan(pageClose);
  });

  it('a // inside a string literal is not a comment', () => {
    const src = '#link("https://example.com/x")[site] #image-placeholder("cap")\n';
    expect(findScreenshotSlots(src).length).toBe(1);
  });

  it('parseStringLiteral honours Typst escapes', () => {
    expect(parseStringLiteral('"a\\nb"')).toBe('a\nb');
    expect(parseStringLiteral('"tab\\there"')).toBe('tab\there');
    expect(parseStringLiteral('"\\u{1F600}"')).toBe('\u{1F600}');
    expect(parseStringLiteral('"say \\"hi\\""')).toBe('say "hi"');
  });
});

describe('typst source map', () => {
  it('a stray parenthesis in prose does not hide later design lines', () => {
    const src = 'Intro (unbalanced\n#set page(header: [Confidential])\nBody with Confidential\n';
    const regions = designRegions(src);
    expect(regions.length).toBe(1);
    expect(src.slice(regions[0]![0], regions[0]![1])).toContain('#set page');
  });
});

describe('typst geometry', () => {
  it('honours the positional paper argument', () => {
    expect(figureWidthPt('#set page("us-letter")')).toBeCloseTo(figureWidthPt('#set page(paper: "us-letter")'), 3);
  });
});

describe('crop math', () => {
  it('zooming out never lets either side exceed the visible maximum', () => {
    let crop = fitCropToBox(3000, 1000, 0.5, 'contain');
    for (let i = 0; i < 40; i++) crop = zoomCrop(crop, 1.5);
    expect(crop.w).toBeLessThanOrEqual(MAX_VISIBLE_FRACTION + 1e-9);
    expect(crop.h).toBeLessThanOrEqual(MAX_VISIBLE_FRACTION + 1e-9);
  });
});
