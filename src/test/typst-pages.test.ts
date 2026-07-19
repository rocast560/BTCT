import { describe, it, expect } from 'vitest';
import { separateTypstPages, DEFAULT_PAGE_GAP } from '@/lib/typst-pages';

// Minimal stand-in for typst.ts SVG output: two 200×120 pages stacked with no
// gap inside a 200×240 document (matches the real format probed from typst.ts).
const TWO_PAGE_SVG =
  '<svg style="overflow: visible;" class="typst-doc" viewBox="0 0 200.000 240.000" ' +
  'width="200.000" height="240.000" data-width="200.000" data-height="240.000" ' +
  'xmlns="http://www.w3.org/2000/svg">' +
  '<defs id="defs"></defs>' +
  '<g class="typst-page" transform="translate(0, 0)" data-tid="p1" data-page-width="200" data-page-height="120"><text>A</text></g>' +
  '<g class="typst-page" transform="translate(0, 120)" data-tid="p2" data-page-width="200" data-page-height="120"><text>B</text></g>' +
  '</svg>';

describe('separateTypstPages', () => {
  it('counts the pages it recognizes', () => {
    expect(separateTypstPages(TWO_PAGE_SVG).pages).toBe(2);
  });

  it('shifts each page down by a cumulative gap', () => {
    const { svg } = separateTypstPages(TWO_PAGE_SVG, 24);
    // First page stays put; second moves down by exactly one gap (120 + 24).
    expect(svg).toContain('class="typst-page" transform="translate(0, 0)"');
    expect(svg).toContain('class="typst-page" transform="translate(0, 144)"');
    expect(svg).not.toContain('transform="translate(0, 120)"');
  });

  it('adds one white backing rect per page at the shifted position', () => {
    const { svg } = separateTypstPages(TWO_PAGE_SVG, 24);
    const rects = svg.match(/<rect class="typst-page-bg"/g) ?? [];
    expect(rects).toHaveLength(2);
    expect(svg).toContain('<rect class="typst-page-bg" x="0" y="0" width="200" height="120"');
    expect(svg).toContain('<rect class="typst-page-bg" x="0" y="144" width="200" height="120"');
    // Backing cards must paint before (behind) the page content.
    expect(svg.indexOf('typst-pages-bg')).toBeLessThan(svg.indexOf('typst-page" transform'));
  });

  it('grows the root height/viewBox to fit the inserted gaps', () => {
    const { svg } = separateTypstPages(TWO_PAGE_SVG, 24);
    // 240 + (2 - 1) * 24 = 264
    expect(svg).toContain('viewBox="0 0 200.000 264.000"');
    expect(svg).toContain(' height="264.000"');
    expect(svg).toContain('data-height="264.000"');
    // Width is untouched.
    expect(svg).toContain('width="200.000"');
  });

  it('uses a sensible default gap', () => {
    const { svg } = separateTypstPages(TWO_PAGE_SVG);
    expect(svg).toContain(`transform="translate(0, ${120 + DEFAULT_PAGE_GAP})"`);
  });

  it('leaves a single-page document unshifted but still backed', () => {
    const onePage =
      '<svg class="typst-doc" viewBox="0 0 200.000 120.000" width="200.000" height="120.000" data-height="120.000">' +
      '<g class="typst-page" transform="translate(0, 0)" data-tid="p1" data-page-width="200" data-page-height="120"></g>' +
      '</svg>';
    const { svg, pages } = separateTypstPages(onePage);
    expect(pages).toBe(1);
    expect(svg).toContain('<rect class="typst-page-bg"');
    expect(svg).toContain('viewBox="0 0 200.000 120.000"'); // no growth for one page
  });

  it('passes through unrecognized SVG unchanged (graceful fallback)', () => {
    const other = '<svg viewBox="0 0 10 10"><g class="something-else"></g></svg>';
    const { svg, pages } = separateTypstPages(other);
    expect(pages).toBe(0);
    expect(svg).toBe(other);
  });

  it('handles empty input', () => {
    expect(separateTypstPages('')).toEqual({ svg: '', pages: 0 });
  });
});
