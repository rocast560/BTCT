// Run: bun server/typst/bake.check.mjs   (exits non-zero on failure)
import { Jimp } from 'jimp';
import { bakeImage } from './bake.mjs';

// Period 3, not 2: with this region's math the gaussian default downscales
// the 100px region to a 10px strip (an exact stride of 10), so a period-2
// checkerboard has every sample land on the same phase and jimp's
// bilinearInterpolation (point sampling with interpolation only between
// fractional positions) reproduces a flat colour instead of a grey mix.
// gcd(10, 3) is 1, so the stride walks through every phase of a period-3
// pattern and the downscale genuinely blends black and white. Verified this
// is a property of jimp 1.6.1's resize, not the port: the unmodified
// reference bake.ts in the sibling project hits the same flat-colour result
// with a period-2 pattern at this exact region size.
const img = new Jimp({ width: 200, height: 100, color: 0xffffffff });
for (let x = 0; x < 100; x += 1) for (let y = 0; y < 100; y += 1) if ((x + y) % 3 === 0) img.setPixelColor(0x000000ff, x, y);
const original = new Uint8Array(await img.getBuffer('image/png'));

const same = await bakeImage(original, {}, 'a.png');
if (same !== null) throw new Error('no crop and no blur must return null');

const blurred = await bakeImage(original, { blurs: [{ x: 0, y: 0, w: 0.5, h: 1 }] }, 'a.png');
const out = await Jimp.read(Buffer.from(blurred));
const px = out.getPixelColor(10, 10);
if (px === 0x000000ff || px === 0xffffffff) throw new Error('blurred region still shows the original checkerboard');
if (out.getPixelColor(150, 50) !== 0xffffffff) throw new Error('pixels outside the region changed');

// Same check, but with today's defaults for a new region (pixelate, strength 0.4)
// instead of the old-record fallback (gaussian) the case above exercises.
const pixelated = await bakeImage(original, { blurs: [{ x: 0, y: 0, w: 0.5, h: 1, style: 'pixelate', strength: 0.4 }] }, 'a.png');
const outPixelated = await Jimp.read(Buffer.from(pixelated));
const pxPixelated = outPixelated.getPixelColor(10, 10);
if (pxPixelated === 0x000000ff || pxPixelated === 0xffffffff) throw new Error('pixelated region still shows the original checkerboard');
if (outPixelated.getPixelColor(150, 50) !== 0xffffffff) throw new Error('pixels outside the pixelated region changed');

const cropped = await bakeImage(original, { crop: { x: 0, y: 0, w: 0.5, h: 1 } }, 'a.png');
const c = await Jimp.read(Buffer.from(cropped));
if (c.bitmap.width !== 100 || c.bitmap.height !== 100) throw new Error(`crop size ${c.bitmap.width}x${c.bitmap.height}`);

let threw = false;
try { await bakeImage(original, { blurs: [{ x: 0, y: 0, w: 1, h: 1 }] }, 'a.webp'); } catch { threw = true; }
if (!threw) throw new Error('an un-bakeable format with a blur must throw, never pass through');
console.log('bake: ok');
