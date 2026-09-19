// One export's working directory: main.typ, baked images under assets/, the
// workspace's own fonts under fonts/. Always removed by the caller's finally.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTypstSource, listAssetRecords } from '../yjs-data.mjs';
import { ASSETS_DIR } from '../data-export.mjs';
import { getAsset } from '../db.mjs';
import { vetAssetRecord } from './vet-asset.mjs';
import { imageSize } from './image-size.mjs';

export class ExportError extends Error {
  constructor(status, message, diagnostics) { super(message); this.status = status; this.diagnostics = diagnostics; }
}

// Everything the report references plus its fonts has to fit in memory on a
// 1 GB box twice over (read, then bake), so there is a ceiling. Uploads are
// capped at 25 MB each, so this is a few dozen screenshots, far more than a
// real report places.
const MAX_STAGED_MB = 200;
const MAX_STAGED_BYTES = MAX_STAGED_MB * 1024 * 1024;

// File bytes say nothing about what a decode costs. A 6000x6000 PNG of flat
// colour encodes to 0.81 MB and measured 2192 MB of RSS through this server's
// own bakeImage, which is twice the target box. So every staged image is
// sized from its header first (typst decodes the un-baked ones itself, so the
// cap applies to those too), and one export gets a cumulative decode budget
// on top: the bakes are sequential, so this bounds time rather than peak
// memory, and it stops a report from parking a core for a minute.
const MAX_MEGAPIXELS = 30;
const MAX_PIXELS = MAX_MEGAPIXELS * 1_000_000;
const MAX_DECODED_MB = 512;
const MAX_DECODED_BYTES = MAX_DECODED_MB * 1024 * 1024;

/**
 * Basenames of the `/assets/...` paths the report actually mentions.
 *
 * Staging every image in the workspace would cost a decode and a re-encode
 * per unplaced screenshot on every export. Typst resolves an image by path,
 * so a string literal is the only way one can be referenced, and a plain scan
 * of the source finds them all: the figure helper's `path:` argument and a
 * hand-written `#image("/assets/x.png")` are both string literals. A path
 * built at runtime (`image("/assets/" + name)`) is not found, and Typst then
 * reports the unresolved path against its own line, which is the same error
 * an operator would get for a typo.
 *
 * Fonts are not filtered: Typst resolves a font by family name, never by
 * path, so there is nothing in the source to match against.
 */
export function referencedAssetNames(source) {
  const names = new Set();
  const re = /"\/assets\/([^"\\]+)"/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const base = m[1].split('/').pop();
    if (base) names.add(base);
  }
  return names;
}

function statOrNull(file) {
  try { return fs.statSync(file); } catch { return null; }
}

export async function stageReport(workspaceId) {
  const source = await readTypstSource(workspaceId);
  if (source === null) throw new ExportError(404, 'this workspace has no report yet');
  const referenced = referencedAssetNames(source);
  const records = await listAssetRecords(workspaceId);
  // Nothing may sit between this line and the try: the catch is what removes
  // the directory, and the caller's finally only runs once this returns.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'btct-typst-'));
  try {
    fs.mkdirSync(path.join(root, 'assets'));
    fs.mkdirSync(path.join(root, 'fonts'));
    fs.writeFileSync(path.join(root, 'main.typ'), source);
    const { bakeImage } = await import('./bake.mjs'); // jimp loads on first export, not at boot
    let baked = 0;
    let skippedDuplicates = 0;
    let stagedBytes = 0;
    let decodedBytes = 0;
    const warnings = [];
    const account = (n) => {
      stagedBytes += n;
      if (stagedBytes > MAX_STAGED_BYTES) {
        throw new ExportError(422, `this report's images and fonts total more than ${MAX_STAGED_MB} MB, too much to export on this server`);
      }
    };
    for (const a of records) {
      // Every field that reaches the filesystem is vetted first, and `kind`
      // comes back from the server's own inventory rather than the record.
      // A record that fails is skipped without a word: it cannot be a real
      // upload, so there is nothing to tell the operator about.
      const id = typeof a?.id === 'string' ? a.id : '';
      const vetted = vetAssetRecord(a, id ? getAsset(id) : null, workspaceId, ASSETS_DIR);
      if (!vetted.ok) continue;
      const { from, name } = vetted;
      const stat = statOrNull(from);
      if (!stat || !stat.isFile()) continue; // Typst reports the unresolved path against its line
      const isFont = vetted.kind === 'font';
      if (!isFont && !referenced.has(name)) continue;
      // Two records can carry the same filename: the Assets Manager
      // de-duplicates on upload, but records sync through a CRDT any client
      // can write. Overwriting the first with the second's bytes would
      // silently put the wrong picture under a caption, so keep the first
      // and say so.
      const dest = path.join(root, isFont ? 'fonts' : 'assets', name);
      if (fs.existsSync(dest)) {
        skippedDuplicates += 1;
        warnings.push(`Two assets are named ${name}; only the first was used.`);
        continue;
      }
      account(stat.size);
      if (isFont) { fs.copyFileSync(from, dest); continue; }
      const bytes = new Uint8Array(fs.readFileSync(from));
      // Reading the file is cheap and bounded by the 25 MB upload cap;
      // decoding it is what has to be refused, so the header decides.
      const dims = imageSize(bytes);
      // A superset of what bakeImage treats as work: a full-frame crop counts
      // here and not there, which errs towards refusing.
      const mayBake = !!a.crop || (Array.isArray(a.blurs) && a.blurs.length > 0);
      if (dims && dims.width * dims.height > MAX_PIXELS) {
        throw new ExportError(422, `${name} is too large to export from the server (${dims.width} x ${dims.height}). Export the PDF from the browser instead, or downscale the screenshot.`);
      }
      if (!dims && mayBake) {
        throw new ExportError(422, `${name} cannot be sized from its header, so the server will not redact it. Export the PDF from the browser instead.`);
      }
      if (dims && mayBake) {
        decodedBytes += dims.width * dims.height * 4;
        if (decodedBytes > MAX_DECODED_BYTES) {
          throw new ExportError(422, `this report needs more than ${MAX_DECODED_MB} MB of image decoding in one export. Export the PDF from the browser instead, or downscale the screenshots.`);
        }
      }
      let out;
      try { out = await bakeImage(bytes, { crop: a.crop ?? null, blurs: a.blurs ?? null }, name); }
      catch (err) { throw new ExportError(422, `${name}: ${err instanceof Error ? err.message : String(err)}`); }
      const written = out ?? bytes;
      account(Math.max(0, written.byteLength - stat.size)); // a re-encode can grow
      fs.writeFileSync(dest, written);
      if (out) baked += 1;
    }
    return { root, source, baked, skippedDuplicates, warnings };
  } catch (err) {
    unstage(root);
    throw err;
  }
}

export function unstage(root) {
  // Never throws: this runs from a finally and from the catch above, where a
  // second error would replace the one the caller needs to see.
  try { fs.rmSync(root, { recursive: true, force: true }); }
  catch (err) { console.error('[typst] could not remove the staged directory', err); }
}
