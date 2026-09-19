// The report, rewritten into Typst that pandoc's reader can follow: figure
// slots become plain #figure calls (pandoc does not evaluate the report's own
// #image-placeholder helper) and asset paths become relative to the staged
// directory (pandoc knows nothing of Typst's --root). Pure.
import { findScreenshotSlots } from '../../src/lib/typst-placeholders.ts';

const escapeContent = (s) => s.replace(/([\\\[\]#*_`$@<])/g, '\\$1');

export function toPandocSource(source) {
  let out = source;
  // Right to left, so earlier offsets stay valid.
  for (const slot of [...findScreenshotSlots(source)].reverse()) {
    const caption = escapeContent(slot.caption ?? 'Figure');
    const rel = slot.path ? slot.path.replace(/^\/+/, '') : null;
    const replacement = rel
      ? `#figure(image("${rel}"), caption: [${caption}])`
      : `_[Figure pending: ${caption}]_`;
    out = out.slice(0, slot.start) + replacement + out.slice(slot.end);
  }
  return out.replace(/(\bimage\(\s*")\/+/g, '$1');
}
