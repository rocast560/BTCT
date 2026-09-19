import { describe, it, expect } from 'vitest';
import { toPandocSource } from '../../server/typst/docx-source.mjs';

describe('toPandocSource', () => {
  it('expands a placed slot into a plain figure with a relative path', () => {
    const src = '= Finding\n#image-placeholder("Login bypass", path: "/assets/login.png", height: 3in)\nAfter.';
    expect(toPandocSource(src)).toBe('= Finding\n#figure(image("assets/login.png"), caption: [Login bypass])\nAfter.');
  });
  it('turns an empty slot into a caption-only note', () => {
    expect(toPandocSource('#image-placeholder("Pending shot")')).toBe('_[Figure pending: Pending shot]_');
  });
  it('relativizes direct image calls and leaves other text alone', () => {
    expect(toPandocSource('#image("/assets/a.png", width: 50%)\n"/assets/" in prose')).toBe('#image("assets/a.png", width: 50%)\n"/assets/" in prose');
  });
  it('escapes brackets in captions', () => {
    expect(toPandocSource('#image-placeholder("a [b]", path: "/assets/x.png")')).toContain('caption: [a \\[b\\]]');
  });
});
