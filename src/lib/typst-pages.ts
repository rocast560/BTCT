// ─────────────────────────────────────────────────────────────────────────
// Visually separate the pages of a rendered Typst document.
//
// typst.ts renders a multi-page document into ONE <svg> with each page as a
// `<g class="typst-page" transform="translate(x,y)" data-page-width=W
// data-page-height=H>` stacked vertically with ZERO gap and NO page background
// (pages are transparent). Drawn as-is on a single white card they read as one
// continuous sheet.
//
// This pure transform reflows that SVG so the preview shows distinct pages,
// typst.app-style: each page is pushed down by a cumulative gap, gets its own
// white backing rect with a drop shadow, and the root height is grown to fit.
// It only rewrites geometry/adds rects (the page content is untouched) and
// is applied for the on-screen preview only (SVG/PDF export keep the real,
// gap-free document).
// ─────────────────────────────────────────────────────────────────────────

/** Gap between pages, in SVG user units (≈ pt). Scales with the preview zoom. */
export const DEFAULT_PAGE_GAP = 24;

// Matches a top-level page group's opening tag as emitted by typst.ts 0.7.
// Attribute order is stable: class, transform, data-tid, data-page-width,
// data-page-height. If the format ever changes this simply matches nothing and
// the caller falls back to the un-separated SVG.
const PAGE_TAG_RE =
  /<g class="typst-page" transform="translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)" data-tid="([^"]*)" data-page-width="([\d.]+)" data-page-height="([\d.]+)">/g;

export interface SeparatedSvg {
  /** The reflowed SVG (or the original string if no pages were recognized). */
  svg: string;
  /** Number of pages recognized & separated (0 ⇒ nothing changed). */
  pages: number;
}

/**
 * Reflow a typst.ts SVG so its pages are separated by `gap` user units, each
 * sitting on its own white, shadowed card. Returns the original string with
 * `pages: 0` if no page groups are recognized (caller should then fall back to
 * its own background).
 */
export function separateTypstPages(svg: string, gap: number = DEFAULT_PAGE_GAP): SeparatedSvg {
  if (!svg) return { svg, pages: 0 };

  const backgrounds: string[] = [];
  let count = 0;

  const shifted = svg.replace(PAGE_TAG_RE, (_match, x, y, tid, w, h) => {
    const nx = parseFloat(x);
    const ny = parseFloat(y) + count * gap;
    backgrounds.push(
      `<rect class="typst-page-bg" x="${nx}" y="${ny}" width="${w}" height="${h}" ` +
        `fill="#ffffff" style="filter:drop-shadow(0 1px 5px rgba(0,0,0,0.30))"/>`,
    );
    count++;
    return (
      `<g class="typst-page" transform="translate(${nx}, ${ny})" data-tid="${tid}" ` +
      `data-page-width="${w}" data-page-height="${h}">`
    );
  });

  if (count === 0) return { svg, pages: 0 };

  // Inject the white page cards right after the opening <svg> tag so they paint
  // behind every page (SVG paints in document order).
  const svgTagEnd = shifted.indexOf('>') + 1;
  const withBackgrounds =
    shifted.slice(0, svgTagEnd) +
    `<g class="typst-pages-bg">${backgrounds.join('')}</g>` +
    shifted.slice(svgTagEnd);

  const addedHeight = (count - 1) * gap;
  const grown = addedHeight > 0 ? growRootHeight(withBackgrounds, addedHeight) : withBackgrounds;

  return { svg: grown, pages: count };
}

/** Grow the root <svg>'s height (viewBox 4th value, height attr, data-height). */
function growRootHeight(svg: string, addedHeight: number): string {
  return svg.replace(/^<svg\b[^>]*>/, (tag) =>
    tag
      .replace(
        /viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/,
        (_m, vx, vy, vw, vh) => `viewBox="${vx} ${vy} ${vw} ${(parseFloat(vh) + addedHeight).toFixed(3)}"`,
      )
      .replace(/ height="([\d.]+)"/, (_m, hh) => ` height="${(parseFloat(hh) + addedHeight).toFixed(3)}"`)
      .replace(/data-height="([\d.]+)"/, (_m, hh) => `data-height="${(parseFloat(hh) + addedHeight).toFixed(3)}"`),
  );
}
