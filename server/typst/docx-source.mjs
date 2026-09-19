// The report, rewritten into Typst that pandoc's reader can follow: figure
// slots become plain #figure calls (pandoc does not evaluate the report's own
// #image-placeholder helper) and asset paths become relative to the staged
// directory (pandoc knows nothing of Typst's --root). Pure.
import { findScreenshotSlots } from '../../src/lib/typst-placeholders.ts';

// `/` is in the escaped set because Typst treats `//` as a line comment
// even inside content brackets (except right after `:`); an unescaped
// caption like "Open redirect to //evil.com" leaves an unclosed `[...]`
// and aborts the whole conversion.
const escapeContent = (s) => s.replace(/([\\/[\]#*_`$@<])/g, '\\$1');

export function toPandocSource(source) {
  let out = source;
  // Right to left, so earlier offsets stay valid.
  for (const slot of [...findScreenshotSlots(source)].reverse()) {
    // A computed caption (not a plain string literal) cannot be evaluated by
    // pandoc's reader, so this falls back to the word "Figure";
    // pandocSourceWarnings reports which slots lost their caption text this way.
    const caption = escapeContent(slot.caption ?? 'Figure');
    const rel = slot.path ? slot.path.replace(/^\/+/, '') : null;
    const replacement = rel
      ? `#figure(image("${rel}"), caption: [${caption}])`
      : `_[Figure pending: ${caption}]_`;
    out = out.slice(0, slot.start) + replacement + out.slice(slot.end);
  }
  // This runs over the whole source, so an image("/...") inside a raw or code block is rewritten too; image(variable) is not resolved, so that image will be missing from the Word file.
  return out.replace(/(\bimage\(\s*")\/+/g, '$1');
}

/**
 * Slots whose caption pandoc cannot render faithfully: a computed caption
 * (not a plain string literal) is replaced with the word "Figure" in
 * toPandocSource's output, silently, unless a caller surfaces this list.
 */
export function pandocSourceWarnings(source) {
  const out = [];
  for (const slot of findScreenshotSlots(source)) {
    if (slot.caption === null) {
      out.push(`Figure slot ${slot.index + 1} (line ${slot.line}): the caption is computed, so the Word file shows "Figure" instead.`);
    }
  }
  return out;
}
