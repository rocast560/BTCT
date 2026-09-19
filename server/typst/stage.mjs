// One export's working directory: main.typ, baked images under assets/, the
// workspace's own fonts under fonts/. Always removed by the caller's finally.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTypstSource, listAssetRecords } from '../yjs-data.mjs';
import { ASSETS_DIR } from '../data-export.mjs';
import { getAsset } from '../db.mjs';
import { vetAssetRecord } from './vet-asset.mjs';
import { imageSize, looksLikeSvg, svgRefusal } from './image-size.mjs';
import { createPixelBudget } from './pixel-budget.mjs';

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
//
// The per-image ceiling is measured, not guessed. Peak working set of this
// server for
// one export of a blurred PNG, each on a freshly started process whose
// baseline was 233 MB (2026-09-19, jimp 1.6, Windows):
//
//     3.7 MP (2560x1440)   405 MB
//     8.3 MP (3840x2160)   654 MB
//     9.0 MP (3000x3000)   689 MB
//    12.0 MP (3464x3464)   840 MB
//    16.0 MP (4000x4000)  1027 MB
//    25.0 MP (5000x5000)  1361 MB
//
// That is about 50 MB of peak per megapixel, on a box with 1 GB for
// everything including the Yjs relay. 10 MP is the first round number above
// a 4K screenshot (8.3 MP), which has to keep working, and it lands near
// 730 MB. A 5K screenshot is refused and exports from the browser instead.
const MAX_MEGAPIXELS = 10;
const MAX_PIXELS = MAX_MEGAPIXELS * 1_000_000;
const SVG_NAME = /\.svg$/i;

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
    const budget = createPixelBudget();
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
      // The .svg name is what buys the unsized exemption below, and typst
      // picks its decoder from that name too, so the bytes have to agree
      // with it either way, and an SVG that could hide a raster inside
      // itself does not get the exemption at all.
      if (SVG_NAME.test(name)) {
        const refusal = svgRefusal(bytes, name);
        if (refusal) throw new ExportError(422, refusal);
        if (!looksLikeSvg(bytes)) {
          throw new ExportError(422, `${name}: this file is named .svg but does not contain SVG, so it cannot be exported from the server.`);
        }
      }
      if (!dims) {
        // Nothing unsized reaches a decoder. An un-baked image is still
        // decoded, by the typst child rather than by jimp: a 5560-byte
        // 12000x12000 lossless WebP took it to a 958 MB working set, which
        // is the whole container. SVG is the single exemption, because it
        // has no pixel dimensions to read and rasterizes at the size the
        // layout asks for, and it has to look like SVG to claim it.
        if (!(SVG_NAME.test(name) && looksLikeSvg(bytes))) {
          throw new ExportError(422, `${name}: this image's size could not be read, so it cannot be exported from the server.`);
        }
        if (mayBake) {
          throw new ExportError(422, `${name} cannot be sized from its header, so the server will not redact it. Export the PDF from the browser instead.`);
        }
      } else if (dims.width * dims.height > MAX_PIXELS) {
        throw new ExportError(422, `${name} is too large to export from the server (${dims.width} x ${dims.height}). Export the PDF from the browser instead, or downscale the screenshot.`);
      }
      // Counted for every staged raster, redacted or not, and counted here
      // so a report with forty screenshots is refused while it is being
      // staged rather than after. This replaces a budget that only counted
      // images with a crop or a blur on them, which left the common case
      // (placed screenshots, nothing redacted) with no total bound at all:
      // typst holds each decoded bitmap while it writes the PDF, so file
      // bytes never stood in for it.
      const overBudget = budget.add(dims);
      if (overBudget) throw new ExportError(422, overBudget);
      let out;
      // bakeImage's own message already starts with the filename.
      try { out = await bakeImage(bytes, { crop: a.crop ?? null, blurs: a.blurs ?? null }, name); }
      catch (err) { throw new ExportError(422, err instanceof Error ? err.message : String(err)); }
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
  // second error would replace the one the caller needs to see. The retries
  // are for Windows, where a file a just-killed child had open answers EBUSY
  // for a moment, and giving up there would leave screenshots in the OS temp
  // directory.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (err) { console.error('[typst] could not remove the staged directory', err); }
}
