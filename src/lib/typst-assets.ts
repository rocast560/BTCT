// ─────────────────────────────────────────────────────────────────────────
// Client side of the Typst asset pipeline: upload, fetch, crop, blur, and
// hand the resulting bytes to the compiler's virtual filesystem.
//
// The crop is applied *here*, not in Typst. When an asset carries a crop
// rect we decode the original, draw the selected region to a canvas, and
// shadow the result into the compiler under the asset's filename. From the
// document's point of view `#image("/assets/shot.png")` simply *is* the
// framed image.
//
// Because the crop rect carries the figure box's aspect ratio (see
// crop-math.ts), the bytes drop into the box with no letterboxing and no
// distortion: the crop editor's viewport and the rendered figure show the
// same thing. A rect extending past the image edge is legal and renders as
// the placeholder grey, baked in here so the two stay identical.
//
// Everything is cached by content identity: raw bytes by asset id (they're
// immutable server-side) and cropped bytes by id + crop rect. Re-rendering
// on every keystroke therefore costs nothing after the first decode.
// ─────────────────────────────────────────────────────────────────────────

import { API_URL, useAuthStore } from '@/auth/auth-store';
import { blurParams, blursKey, effectiveStyle, hasBlurs, pixelParams } from './blur-math';
import { cropToPixels, isFullFrame, normalizeCrop, outputSize } from './crop-math';
import {
  ENCODABLE_FORMATS,
  formatFromFilename,
  mimeForFormat,
  reencodeTargetFor,
  sniffImageFormat,
  type ImageFormat,
} from './image-format';
import type { BlurRegion, CropRect, TypstAsset, TypstAssetKind } from '@/types';

// Re-exported so callers have one import site for the asset pipeline.
export { isFullFrame, normalizeCrop } from './crop-math';

/** Directory the assets are mounted under inside the Typst virtual FS. */
export const ASSET_DIR = '/assets';

/** The Typst path for an asset: what goes inside `#image("…")`. */
export function assetPath(asset: Pick<TypstAsset, 'filename'>): string {
  return `${ASSET_DIR}/${asset.filename}`;
}

export interface UploadedAsset {
  id: string;
  workspaceId: string;
  kind: TypstAssetKind;
  filename: string;
  mime: string;
  size: number;
}

function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * POST the raw file bytes. `filename` is passed as a query param and
 * sanitized server-side; the returned metadata carries the name that was
 * actually stored, which may differ from what was requested.
 */
export async function uploadAsset(
  file: File | Blob,
  opts: { workspaceId: string; kind: TypstAssetKind; filename: string },
): Promise<UploadedAsset> {
  const qs = new URLSearchParams({
    workspaceId: opts.workspaceId,
    kind: opts.kind,
    filename: opts.filename,
  });
  const res = await fetch(`${API_URL}/api/assets?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...authHeaders() },
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; asset?: UploadedAsset };
  if (!res.ok || !data.asset) {
    throw new Error(data.error || `upload failed (${res.status})`);
  }
  return data.asset;
}

export async function deleteAssetBytes(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/assets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 404) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `delete failed (${res.status})`);
  }
}

// ── byte cache ───────────────────────────────────────────────────────────
// Asset bytes are immutable for a given id, so this cache never needs
// invalidating within a session. Keyed by id; entries are the in-flight
// promise so concurrent callers share one request.
//
// Capped as an LRU: original bytes are only needed when the framing changes
// (a settled framing is served from croppedCache), so retaining every
// screenshot's raw bytes for the whole session would cost megabytes per
// asset for data a local fetch can restore in milliseconds.
const rawBytesCache = new Map<string, Promise<Uint8Array>>();
const RAW_CACHE_MAX = 12;

/** Fetch (and memoize) an asset's original bytes. */
export function fetchAssetBytes(id: string): Promise<Uint8Array> {
  const hit = rawBytesCache.get(id);
  if (hit) {
    // Refresh recency: Map iteration order is insertion order.
    rawBytesCache.delete(id);
    rawBytesCache.set(id, hit);
    return hit;
  }
  const p = (async () => {
    const res = await fetch(`${API_URL}/api/assets/${encodeURIComponent(id)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `asset ${id} unavailable (${res.status})`);
    }
    return new Uint8Array(await res.arrayBuffer());
  })();
  // Don't cache a rejection: a transient network blip shouldn't poison the
  // asset for the rest of the session.
  p.catch(() => { rawBytesCache.delete(id); });
  rawBytesCache.set(id, p);
  while (rawBytesCache.size > RAW_CACHE_MAX) {
    const oldest = rawBytesCache.keys().next().value;
    if (oldest === undefined) break;
    rawBytesCache.delete(oldest);
  }
  return p;
}

/** Drop an asset from the byte caches (called when it's deleted). */
export function forgetAsset(id: string): void {
  rawBytesCache.delete(id);
  for (const key of [...croppedCache.keys()]) {
    if (key.startsWith(`${id}:`)) croppedCache.delete(key);
  }
}

// ── cropping ─────────────────────────────────────────────────────────────
const croppedCache = new Map<string, Promise<Uint8Array>>();

/** Stable cache key for a crop rect, rounded to avoid float churn. */
function cropKey(crop: CropRect): string {
  const r = (n: number) => Math.round(n * 10000) / 10000;
  return `${r(crop.x)},${r(crop.y)},${r(crop.w)},${r(crop.h)}`;
}

/** Decode bytes into a bitmap we can draw from. */
async function decodeImage(bytes: Uint8Array, mime: string): Promise<ImageBitmap | HTMLImageElement> {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch { /* fall through to <img> */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('could not decode image'));
      img.src = url;
    });
  } finally {
    // Revoke on the next tick: Safari needs the URL alive through decode.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function imageSize(
  img: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
): { w: number; h: number } {
  return 'naturalWidth' in img
    ? { w: img.naturalWidth, h: img.naturalHeight }
    : { w: img.width, h: img.height };
}

/** Read an image file's natural dimensions without keeping it decoded. */
export async function readImageSize(file: Blob): Promise<{ width: number; height: number }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const img = await decodeImage(bytes, file.type || 'image/png');
  const { w, h } = imageSize(img);
  if ('close' in img) img.close();
  return { width: w, height: h };
}

/** JPEG quality for re-encodes. High enough that screenshot text stays crisp. */
const JPEG_QUALITY = 0.94;

async function canvasToBytes(canvas: HTMLCanvasElement, mime: string): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), mime, mime === 'image/jpeg' ? JPEG_QUALITY : undefined),
  );
  if (!blob) throw new Error(`canvas could not encode ${mime}`);
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * `luma(245)`: the placeholder grey. Gaps are baked into the image rather
 * than left to Typst so the crop editor and the PDF agree exactly: what the
 * viewport shows is literally the bytes that get written.
 */
export const GAP_FILL = '#f5f5f5';

/**
 * Draw a region of `img` onto a fresh canvas and encode it as `targetFormat`.
 *
 * The source region may sit partly (or wholly) outside the image: that's how
 * the viewport model expresses an image scaled smaller than the figure box.
 * The canvas spec clips the source rectangle and scales the destination in
 * the same proportion, so the pre-filled background shows through wherever
 * the image doesn't reach.
 *
 * The fill also covers JPEG's lack of an alpha channel: a transparent source
 * would otherwise composite against black.
 */
async function renderRegion(
  img: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  region: { sx: number; sy: number; sw: number; sh: number },
  targetFormat: ImageFormat,
  out?: { width: number; height: number },
): Promise<Uint8Array> {
  const { sx, sy, sw, sh } = region;
  const width = out?.width ?? sw;
  const height = out?.height ?? sh;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.fillStyle = GAP_FILL;
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img as CanvasImageSource, sx, sy, sw, sh, 0, 0, width, height);
  return canvasToBytes(canvas, mimeForFormat(targetFormat));
}

/**
 * Bake the blur regions onto a full-resolution copy of the image.
 *
 * Each region is drawn at a heavy downscale first and only then re-enlarged
 * through a gaussian filter. The downscale is what destroys the information:
 * a gaussian alone on readable text can sometimes be deconvolved, and this
 * is a pentest tool, so a redaction has to actually redact. The numbers come
 * from `blurParams` (pure, tested) so the editor preview and the compiled
 * PDF apply exactly the same strength.
 */
function bakeBlurs(
  img: ImageBitmap | HTMLImageElement,
  natW: number,
  natH: number,
  blurs: BlurRegion[],
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = natW;
  canvas.height = natH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(img as CanvasImageSource, 0, 0);

  for (const region of blurs) {
    const sx = Math.round(region.x * natW);
    const sy = Math.round(region.y * natH);
    const sw = Math.max(1, Math.round(region.w * natW));
    const sh = Math.max(1, Math.round(region.h * natH));

    const small = document.createElement('canvas');
    const sctx = small.getContext('2d');
    if (!sctx) throw new Error('2D canvas unavailable');

    if (effectiveStyle(region) === 'pixelate') {
      // Mosaic: average the region down to whole blocks, then re-enlarge
      // with smoothing off so each block comes back as a hard square.
      const { blockPx } = pixelParams(region, natW, natH);
      small.width = Math.max(1, Math.round(sw / blockPx));
      small.height = Math.max(1, Math.round(sh / blockPx));
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, small.width, small.height);

      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, sy, sw, sh);
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, small.width, small.height, sx, sy, sw, sh);
      ctx.restore();
    } else {
      const { radiusPx, downscale } = blurParams(region, natW, natH);
      small.width = Math.max(1, Math.round(sw * downscale));
      small.height = Math.max(1, Math.round(sh * downscale));
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, small.width, small.height);

      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, sy, sw, sh);
      ctx.clip();
      ctx.filter = `blur(${radiusPx}px)`;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // Overscan past the region by the blur radius: the filter's edge falloff
      // goes transparent, and without the overscan the sharp original would
      // show through in a thin halo at the region border.
      ctx.drawImage(small, sx - radiusPx, sy - radiusPx, sw + radiusPx * 2, sh + radiusPx * 2);
      ctx.restore();
    }
  }
  return canvas;
}

/**
 * Apply a normalized crop rect (and any blur regions) to image bytes.
 *
 * `targetFormat` must match the extension of the path these bytes will be
 * mounted at: Typst selects its decoder from the extension, so re-encoding a
 * cropped `.jpg` as PNG produces "Illegal start bytes: 8950" at compile time.
 */
export async function cropImageBytes(
  bytes: Uint8Array,
  mime: string,
  crop: CropRect,
  targetFormat: ImageFormat = 'png',
  blurs?: BlurRegion[] | null,
): Promise<Uint8Array> {
  const img = await decodeImage(bytes, mime);
  const { w: natW, h: natH } = imageSize(img);
  const rect = normalizeCrop(crop);
  const region = cropToPixels(rect, natW, natH);
  const out = outputSize(rect, natW, natH);
  try {
    const source = hasBlurs(blurs) ? bakeBlurs(img, natW, natH, blurs as BlurRegion[]) : img;
    return await renderRegion(source, region, targetFormat, out);
  } finally {
    if ('close' in img) img.close();
  }
}

/**
 * Re-encode whole bytes into `targetFormat`, leaving the framing alone.
 * Blur regions, if given, are baked in on the way through.
 */
async function convertImageBytes(
  bytes: Uint8Array,
  mime: string,
  targetFormat: ImageFormat,
  blurs?: BlurRegion[] | null,
): Promise<Uint8Array> {
  const img = await decodeImage(bytes, mime);
  const { w, h } = imageSize(img);
  try {
    const source = hasBlurs(blurs) ? bakeBlurs(img, w, h, blurs as BlurRegion[]) : img;
    return await renderRegion(source, { sx: 0, sy: 0, sw: w, sh: h }, targetFormat);
  } finally {
    if ('close' in img) img.close();
  }
}

/**
 * The full image with its blur regions baked in, as PNG bytes: what the
 * place dialog shows in the viewport, so the editor previews exactly the
 * pixels the compiler will receive.
 */
export function blurredPreviewBytes(
  bytes: Uint8Array,
  mime: string,
  blurs: BlurRegion[],
): Promise<Uint8Array> {
  return convertImageBytes(bytes, mime, 'png', blurs);
}

/**
 * The bytes to shadow into the compiler for this asset.
 *
 * Enforces the invariant that makes Typst's extension-based decoding safe:
 * **the bytes mounted at a path are always in the format that path's
 * extension claims.** Two things can violate it: cropping (which re-encodes)
 * and a mislabelled upload (a PNG saved as `shot.jpg`), and both are fixed
 * here, so the document's `#image("/assets/shot.jpg")` keeps working either
 * way and the path never changes with crop state.
 *
 * Formats a canvas can't produce (GIF, SVG) are passed through untouched:
 * re-encoding them isn't possible, and for SVG rasterizing would throw away
 * resolution independence.
 */
export function resolveAssetBytes(asset: TypstAsset): Promise<Uint8Array> {
  if (asset.kind !== 'image') return fetchAssetBytes(asset.id);

  const claimed = formatFromFilename(asset.filename);
  const wantsCrop = !isFullFrame(asset.crop);
  const wantsBlur = hasBlurs(asset.blurs);

  // Nothing a canvas can produce → mount as-is. (An SVG crop rect or blur
  // region is ignored rather than rasterized.)
  if (!claimed || !ENCODABLE_FORMATS.has(claimed)) return fetchAssetBytes(asset.id);

  const key = `${asset.id}:${claimed}:${wantsCrop ? cropKey(asset.crop as CropRect) : 'full'}:${blursKey(asset.blurs)}`;
  const hit = croppedCache.get(key);
  if (hit) return hit;

  const p = fetchAssetBytes(asset.id).then(async (raw) => {
    const actual = sniffImageFormat(raw);
    if (wantsCrop) {
      return cropImageBytes(
        raw, mimeForFormat(actual ?? claimed), asset.crop as CropRect, claimed, asset.blurs,
      );
    }
    if (wantsBlur) {
      return convertImageBytes(raw, mimeForFormat(actual ?? claimed), claimed, asset.blurs);
    }
    // Untouched framing: only re-encode if the bytes disagree with the extension.
    if (reencodeTargetFor(asset.filename, actual) === null) return raw;
    return convertImageBytes(raw, mimeForFormat(actual ?? claimed), claimed);
  });
  p.catch(() => { croppedCache.delete(key); });
  // A framing tweak makes every older render of this asset unreachable
  // (callers always key off the record's current crop + blurs), so drop
  // them: without this, a session of crop/blur adjustments retains every
  // intermediate multi-MB encode until the tab closes.
  for (const k of [...croppedCache.keys()]) {
    if (k !== key && k.startsWith(`${asset.id}:`)) croppedCache.delete(k);
  }
  croppedCache.set(key, p);
  return p;
}

// ── auto-detect content bounds ───────────────────────────────────────────

/**
 * Find the bounding box of the "interesting" part of an image by trimming
 * uniform borders: the letterboxing you get from a full-screen capture of
 * a window, or the flat background around a dialog.
 *
 * Works by sampling the four corners for a background color, then walking
 * in from each edge while every pixel on that row/column stays within
 * `tolerance` of it. Returns null when there's nothing to trim (the borders
 * aren't uniform, or trimming would remove nearly everything), so the
 * caller can leave the existing crop alone rather than mangling the image.
 */
export async function detectContentBounds(
  bytes: Uint8Array,
  mime: string,
  tolerance = 12,
): Promise<CropRect | null> {
  const img = await decodeImage(bytes, mime);
  const { w, h } = imageSize(img);
  if (w < 4 || h < 4) return null;

  // Downsample large images: border detection doesn't need full resolution
  // and a 4K screenshot would otherwise mean scanning 8M pixels.
  const MAX_DIM = 900;
  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img as CanvasImageSource, 0, 0, sw, sh);
  if ('close' in img) img.close();

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, sw, sh).data;
  } catch {
    // Tainted canvas (shouldn't happen for same-origin bytes): bail safely.
    return null;
  }

  // `?? 0` keeps this total under noUncheckedIndexedAccess; the indices are
  // in range by construction.
  const at = (x: number, y: number) => {
    const i = (y * sw + x) * 4;
    return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0] as const;
  };

  // Background = the most common of the four corners, so a single odd
  // corner (a rounded window shadow, say) doesn't decide it.
  const corners = [at(0, 0), at(sw - 1, 0), at(0, sh - 1), at(sw - 1, sh - 1)];
  const counts = new Map<string, { px: readonly [number, number, number]; n: number }>();
  for (const px of corners) {
    const k = px.join(',');
    const e = counts.get(k) ?? { px, n: 0 };
    e.n++;
    counts.set(k, e);
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n);
  const bg = ranked[0]?.px;
  if (!bg) return null;

  const isBg = (x: number, y: number) => {
    const [r, g, b] = at(x, y);
    return (
      Math.abs(r - bg[0]) <= tolerance &&
      Math.abs(g - bg[1]) <= tolerance &&
      Math.abs(b - bg[2]) <= tolerance
    );
  };
  const rowIsBg = (y: number) => {
    for (let x = 0; x < sw; x++) if (!isBg(x, y)) return false;
    return true;
  };
  const colIsBg = (x: number) => {
    for (let y = 0; y < sh; y++) if (!isBg(x, y)) return false;
    return true;
  };

  let top = 0;
  while (top < sh - 1 && rowIsBg(top)) top++;
  let bottom = sh - 1;
  while (bottom > top && rowIsBg(bottom)) bottom--;
  let left = 0;
  while (left < sw - 1 && colIsBg(left)) left++;
  let right = sw - 1;
  while (right > left && colIsBg(right)) right--;

  const cw = right - left + 1;
  const ch = bottom - top + 1;

  // Nothing meaningful trimmed, or we'd have cropped away the whole image
  // (a photo with no flat border hits the second case).
  const trimmed = 1 - (cw * ch) / (sw * sh);
  if (trimmed < 0.005) return null;
  if (cw < sw * 0.05 || ch < sh * 0.05) return null;

  return normalizeCrop({ x: left / sw, y: top / sh, w: cw / sw, h: ch / sh });
}

// ── font metadata ────────────────────────────────────────────────────────

/**
 * Read the family name out of a font file so the UI can tell the operator
 * exactly what to put in `#set text(font: "…")`.
 *
 * Uses typst.ts's own font parser rather than a separate OpenType library:
 * it's already loaded, and (more importantly) it reports the name the
 * *compiler* will match on. A name from a different parser could disagree
 * for fonts with several name-table entries, which would send the operator
 * chasing a font Typst can't find.
 */
export async function readFontFamily(bytes: Uint8Array): Promise<string | null> {
  try {
    const { getFontInfo } = await import('./typst-compiler');
    const info = await getFontInfo(bytes);
    return info?.family ?? null;
  } catch {
    return null;
  }
}
