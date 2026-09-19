import { describe, it, expect } from 'vitest';
import { imageSize } from '../../server/typst/image-size.mjs';

// Dimensions have to come from the header, because the number this guards
// against is the DECODED size: a 6000x6000 PNG encodes to under a megabyte
// and costs gigabytes of RSS to decode.

function png(width: number, height: number, { bitDepth = 8, truncate = 0 } = {}): Uint8Array {
  const buf = new Uint8Array(33 - truncate);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(buf.buffer);
  if (buf.length >= 16) {
    view.setUint32(8, 13); // IHDR length
    buf.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  }
  if (buf.length >= 24) {
    view.setUint32(16, width);
    view.setUint32(20, height);
  }
  if (buf.length >= 25) buf[24] = bitDepth;
  return buf;
}

function jpeg(width: number, height: number, marker = 0xc0): Uint8Array {
  // SOI, a JFIF APP0 to skip over, then the SOFn that carries the size.
  const parts = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, marker, 0x00, 0x11, 0x08];
  parts.push((height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff);
  return new Uint8Array(parts);
}

describe('imageSize', () => {
  it('reads a PNG IHDR', () => {
    expect(imageSize(png(6000, 4000))).toEqual({ width: 6000, height: 4000 });
    expect(imageSize(png(1, 1))).toEqual({ width: 1, height: 1 });
  });

  it('reads a JPEG SOF0 past an APP0 segment', () => {
    expect(imageSize(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('reads the progressive and arithmetic SOF markers too', () => {
    for (const marker of [0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
      expect(imageSize(jpeg(800, 600, marker)), marker.toString(16)).toEqual({ width: 800, height: 600 });
    }
  });

  it('is not fooled by the JPEG markers that are not frame headers', () => {
    // 0xc4 is a Huffman table, 0xc8 is reserved, 0xcc is arithmetic coding.
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      expect(imageSize(jpeg(800, 600, marker)), marker.toString(16)).toBeNull();
    }
  });

  it('reads a GIF logical screen descriptor', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00, 0x00, 0x00, 0x00]);
    expect(imageSize(gif)).toEqual({ width: 320, height: 240 });
  });

  it('returns null for a truncated header', () => {
    expect(imageSize(png(6000, 4000, { truncate: 12 }))).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(imageSize(new Uint8Array())).toBeNull();
  });

  it('returns null for something that is not an image', () => {
    expect(imageSize(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBeNull(); // %PDF-1
    expect(imageSize(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBeNull(); // webp
  });

  it('returns null rather than zero for a zero dimension', () => {
    expect(imageSize(png(0, 100))).toBeNull();
    expect(imageSize(png(100, 0))).toBeNull();
  });
});
