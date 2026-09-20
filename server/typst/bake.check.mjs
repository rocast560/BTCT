// Run: bun server/typst/bake.check.mjs   (exits non-zero on failure)
//
// The pattern is NON-PERIODIC on purpose: a periodic checkerboard can
// resonate with a fixed-size kernel and collapse to a flat extreme colour
// with zero correlation regardless of whether the blur is actually strong
// (a period-3 pattern averaged by a window-3 box blur did exactly that in
// an earlier review round). A seeded PRNG has no period a fixed kernel can
// exploit. 1px cells are the right scale because both blur paths operate
// at roughly 8px or coarser (pixelate's block-size floor; the gaussian
// downscale's effective stride).
//
// What that proves and what it does not: a bake that does nothing, or one
// that leaves a token blur, scores far over the limit and fails here. A
// WEAKENED bake does not. A 2px pixelate block scores 0.236 and a gaussian
// path with the blur kept but the downscale dropped scores 0.161, and both
// pass. The block-size floor and the downscale are what actually make the
// pixels unrecoverable, and they are guarded by the unit tests over
// src/lib/blur-math.ts, not by this correlation.
//
// The 0.25 correlation limit below is measured, not guessed (2026-09-19).
// Against this pattern and region: the real gaussian path (no `style`, the
// old-record fallback) scores corr=0.003 and the real pixelate path
// (`style:'pixelate', strength:0.4`, today's new-region default) scores
// corr=0.033, both comfortably under the limit. Two scratch regressions,
// run against copies of bake.mjs under $TEMP and never committed, prove the
// limit has teeth: a no-op bakeBlurs (does nothing) scores corr=1.000, and
// the weak stand-in from the prior review round (`piece.blur(1)`, no
// downscale) scores corr=0.464, both comfortably over the limit.
import { Jimp } from 'jimp';
import { bakeImage } from './bake.mjs';

// mulberry32: a small, fast, seeded PRNG. A fixed seed keeps the pattern,
// and therefore the numbers above, reproducible run to run.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Left 100x100 of a 200x100 canvas gets 1px black/white noise; the right
// half stays the canvas's white background, for the outside-region check.
const rand = mulberry32(0xc0ffee);
const img = new Jimp({ width: 200, height: 100, color: 0xffffffff });
for (let y = 0; y < 100; y += 1) for (let x = 0; x < 100; x += 1) if (rand() < 0.5) img.setPixelColor(0x000000ff, x, y);
const original = new Uint8Array(await img.getBuffer('image/png'));

function luma(color) {
  const r = (color >>> 24) & 0xff, g = (color >>> 16) & 0xff, b = (color >>> 8) & 0xff;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function lumaGrid(jimpImg, x0, y0, x1, y1) {
  const values = [];
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) values.push(luma(jimpImg.getPixelColor(x, y)));
  return values;
}

function pearson(a, b) {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denomA = 0, denomB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  const denom = Math.sqrt(denomA * denomB);
  return denom === 0 ? 0 : num / denom;
}

// Correlation between the baked output's luma and the original pattern's
// luma, over the region inset 8px on every edge to stay clear of the
// composite boundary.
function regionCorr(outImg) {
  return pearson(lumaGrid(outImg, 8, 8, 92, 92), lumaGrid(img, 8, 8, 92, 92));
}

// The whole right half of the canvas (never touched by any region in this
// script) must stay exactly the canvas background.
function assertUntouched(outImg, label) {
  for (let y = 0; y < 100; y += 1) {
    for (let x = 100; x < 200; x += 1) {
      if (outImg.getPixelColor(x, y) !== 0xffffffff) throw new Error(`${label}: pixel outside the region changed at (${x},${y})`);
    }
  }
}

const LIMIT = 0.25;

const same = await bakeImage(original, {}, 'a.png');
if (same !== null) throw new Error('no crop and no blur must return null');

const noBlurs = await bakeImage(original, { blurs: [] }, 'a.png');
if (noBlurs !== null) throw new Error('an empty blurs array must return null, same as no blurs at all');

const blurred = await bakeImage(original, { blurs: [{ x: 0, y: 0, w: 0.5, h: 1 }] }, 'a.png');
const out = await Jimp.read(Buffer.from(blurred));
const corrGaussian = regionCorr(out);
assertUntouched(out, 'gaussian');

const pixelated = await bakeImage(original, { blurs: [{ x: 0, y: 0, w: 0.5, h: 1, style: 'pixelate', strength: 0.4 }] }, 'a.png');
const outPixelated = await Jimp.read(Buffer.from(pixelated));
const corrPixelate = regionCorr(outPixelated);
assertUntouched(outPixelated, 'pixelate');

console.log(`gaussian: corr=${corrGaussian.toFixed(3)}  pixelate: corr=${corrPixelate.toFixed(3)}  (limit ${LIMIT})`);
if (Math.abs(corrGaussian) >= LIMIT) throw new Error(`gaussian region still correlates with the original pattern (corr=${corrGaussian.toFixed(3)})`);
if (Math.abs(corrPixelate) >= LIMIT) throw new Error(`pixelated region still correlates with the original pattern (corr=${corrPixelate.toFixed(3)})`);

const cropped = await bakeImage(original, { crop: { x: 0, y: 0, w: 0.5, h: 1 } }, 'a.png');
const c = await Jimp.read(Buffer.from(cropped));
if (c.bitmap.width !== 100 || c.bitmap.height !== 100) throw new Error(`crop size ${c.bitmap.width}x${c.bitmap.height}`);

let threw = false;
try { await bakeImage(original, { blurs: [{ x: 0, y: 0, w: 1, h: 1 }] }, 'a.webp'); } catch { threw = true; }
if (!threw) throw new Error('an un-bakeable format with a blur must throw, never pass through');

const uppercase = await bakeImage(original, { blurs: [{ x: 0, y: 0, w: 0.5, h: 1 }] }, 'shot.PNG');
if (uppercase === null) throw new Error('an uppercase extension must still be recognised and baked');

console.log('bake: ok');
