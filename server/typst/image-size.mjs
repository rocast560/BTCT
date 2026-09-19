// Pixel dimensions from an image header, without decoding it.
//
// The file size says nothing about what a decode costs: a 6000x6000 PNG of
// flat colour encodes to under a megabyte and takes over 2 GB of RSS to bake,
// which is the whole box. Reading the header first is what lets the staging
// code refuse that image before jimp ever sees it.
//
// PNG, JPEG, GIF and WebP. WebP earns its share of the code because it is
// the worst of them: a 5560-byte 12000x12000 lossless file took the typst
// child to a 958 MB working set, and the format allows 16383x16383. A format
// whose header is not covered here comes back null, and the caller refuses
// it unless it is an SVG, which has no pixel dimensions to read and nothing
// for a pixel cap to bound.
//
// Pure: no fs, so src/test covers it through the .d.mts beside this file.

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Frame headers. The other 0xc_ markers are not: 0xc4 is a Huffman table,
// 0xc8 is reserved for JPEG extensions and 0xcc is an arithmetic coding
// table, and all three carry a length, so reading a size out of them would
// invent dimensions.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const startsWith = (bytes, sig) => sig.every((b, i) => bytes[i] === b);
const size = (width, height) => (width > 0 && height > 0 ? { width, height } : null);

function pngSize(bytes) {
  if (bytes.length < 24) return null;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  const be32 = (at) => (bytes[at] << 24 >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
  return size(be32(16), be32(20));
}

function jpegSize(bytes) {
  let at = 2; // past SOI
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) { at += 1; continue; } // fill byte or padding
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const length = (bytes[at + 2] << 8) + bytes[at + 3];
    if (length < 2) return null;
    if (JPEG_SOF.has(marker)) {
      if (at + 8 >= bytes.length) return null; // the last byte a frame header needs is at+8
      const height = (bytes[at + 5] << 8) + bytes[at + 6];
      const width = (bytes[at + 7] << 8) + bytes[at + 8];
      return size(width, height);
    }
    if (marker === 0xda) return null; // scan data: no frame header before it
    at += 2 + length;
  }
  return null;
}

function gifSize(bytes) {
  if (bytes.length < 10) return null;
  return size(bytes[6] + (bytes[7] << 8), bytes[8] + (bytes[9] << 8));
}

const fourcc = (bytes, at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

// The canvas size lives in a different place in each of the three chunk
// kinds, and every field is little endian.
function webpSize(bytes) {
  if (bytes.length < 16 || fourcc(bytes, 8) !== 'WEBP') return null;
  const chunk = fourcc(bytes, 12);

  if (chunk === 'VP8X') { // extended format: an explicit canvas, 24 bits each
    if (bytes.length < 30) return null;
    const le24 = (at) => bytes[at] + (bytes[at + 1] << 8) + (bytes[at + 2] << 16);
    return size(le24(24) + 1, le24(27) + 1);
  }

  if (chunk === 'VP8L') { // lossless: 14 bits each, packed from the low bit up
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const packed = (bytes[21] + (bytes[22] << 8) + (bytes[23] << 16) + (bytes[24] << 24)) >>> 0;
    return size((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
  }

  if (chunk === 'VP8 ') { // lossy: a keyframe header behind the start code
    if (bytes.length < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const le14 = (at) => (bytes[at] + (bytes[at + 1] << 8)) & 0x3fff;
    return size(le14(26), le14(28));
  }

  return null;
}

/**
 * Does this look like SVG, whatever the name says?
 *
 * SVG is the one image the staging code accepts without dimensions, so the
 * exemption has to be earned by the bytes and not just by an extension.
 */
export function looksLikeSvg(bytes) {
  if (!bytes || bytes.length < 4) return false;
  let at = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0; // UTF-8 BOM
  while (at < bytes.length && bytes[at] <= 0x20) at += 1; // leading whitespace
  if (bytes[at] !== 0x3c) return false; // must open with '<', which no raster does
  // The `<svg` tag can sit behind an XML declaration, a doctype or a comment,
  // all of which real files carry, so look for it in the first kilobyte
  // rather than demanding it first.
  let head = '';
  for (let i = at; i < Math.min(bytes.length, at + 1024); i += 1) head += String.fromCharCode(bytes[i]);
  return head.toLowerCase().includes('<svg');
}

/**
 * @param bytes the first bytes of the file (the whole file is fine)
 * @returns `{ width, height }`, or null when the format or the header is not readable
 */
export function imageSize(bytes) {
  if (!bytes || bytes.length < 10) return null;
  if (startsWith(bytes, PNG_MAGIC)) return pngSize(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return gifSize(bytes);
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) return webpSize(bytes);
  return null;
}
