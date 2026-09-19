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

/**
 * @param ast the parsed pandoc JSON document
 * @param isStaged called with a target that already matched STAGED_IMAGE; true when that file is really in the staged directory
 * @returns a new AST plus one warning per image that was dropped
 */
export function filterDocxImages(ast, isStaged) {
  const warnings = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
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
    for (const [key, value] of Object.entries(node)) out[key] = walk(value);
    return out;
  };
  return { ast: walk(ast), warnings };
}
