// Confine the images in a pandoc AST to the ones this export staged.
//
// The Word conversion runs in two steps: pandoc reads the report into its
// JSON AST under --sandbox, and a second pandoc call writes that AST to
// .docx. This is the gate between them. It matters because the reader has
// already evaluated the report: `#image("./" + "../x.png")` arrives here as
// the string "./../x.png" and `#image(u)` arrives as whatever `u` held, so a
// target is a final path, not an expression. A regex over the report's source
// text could never say the same.
//
// Anything that is not exactly `assets/<name>`, and anything the caller says
// is not a regular file in the staged assets directory, is replaced by a
// visible placeholder and reported. A missing figure the reader can see beats
// a Word file that quietly carries the server's own files.
//
// Pure: no fs (the caller supplies the existence check), so src/test covers
// it through the .d.mts beside this file.

/** One staged asset, no directory part, no separators of either flavour. */
export const STAGED_IMAGE = /^assets\/[^/\\]+$/;

const MAX_TARGET_CHARS = 80;

// Pandoc's Str holds a word and spaces are their own nodes, so the
// placeholder is written the way the writer expects to receive it.
const placeholder = () => ({
  t: 'Emph',
  c: [{ t: 'Str', c: '[image' }, { t: 'Space' }, { t: 'Str', c: 'not' }, { t: 'Space' }, { t: 'Str', c: 'included]' }],
});

const shorten = (target) => (target.length > MAX_TARGET_CHARS ? `${target.slice(0, MAX_TARGET_CHARS)}...` : target);

// Returned in place of a block that should disappear entirely. A block list
// is an array, so the parent drops it; nothing else can produce this value.
const DROP = Symbol('drop');

/**
 * @param ast the parsed pandoc JSON document
 * @param isStaged called with a target that already matched STAGED_IMAGE; true when that file is really in the staged directory
 * @returns a new AST plus one warning per image that was dropped
 */
export function filterDocxImages(ast, isStaged) {
  const warnings = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.flatMap((item) => {
      const kept = walk(item);
      return kept === DROP ? [] : [kept];
    });
    if (!node || typeof node !== 'object') return node;
    // Raw passthrough goes in the bin. Pandoc's Typst reader produces none
    // today, but raw OpenXML reaching the writer is pasted into
    // document.xml as it stands, and a field code there can make Word fetch
    // a URL when the person the report was sent to opens it. That guarantee
    // should not rest on a detail of someone else's reader.
    if (node.t === 'RawBlock') return DROP;
    if (node.t === 'RawInline') return { t: 'Str', c: '' };
    if (node.t === 'Image') {
      // Fail closed: an image node this does not understand is not one to
      // hand to an unsandboxed writer.
      const target = Array.isArray(node.c) && Array.isArray(node.c[2]) && typeof node.c[2][0] === 'string' ? node.c[2][0] : '';
      if (!STAGED_IMAGE.test(target) || !isStaged(target)) {
        warnings.push(`An image at "${shorten(target)}" was not included in the Word file.`);
        return placeholder();
      }
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      const kept = walk(value);
      // A block only ever sits in a list, so DROP should never surface here.
      // If a future pandoc shape puts one elsewhere, null is at least valid
      // JSON rather than a symbol that stringify would quietly swallow.
      out[key] = kept === DROP ? null : kept;
    }
    return out;
  };
  const filtered = walk(ast);
  return { ast: filtered === DROP ? null : filtered, warnings };
}
