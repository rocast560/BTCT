import { describe, it, expect } from 'vitest';
import { toPandocSource, pandocSourceWarnings } from '../../server/typst/docx-source.mjs';

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
  it('escapes slashes so a caption cannot open a Typst line comment', () => {
    const src = '#image-placeholder("Open redirect to //evil.com", path: "/assets/x.png")';
    expect(toPandocSource(src)).toContain('caption: [Open redirect to \\/\\/evil.com]');
  });
  it('leaves the relative path unescaped', () => {
    const src = '#image-placeholder("Login bypass", path: "/assets/login.png")';
    expect(toPandocSource(src)).toBe('#figure(image("assets/login.png"), caption: [Login bypass])');
  });
  it('falls back to the word "Figure" for a computed caption', () => {
    const src = '#image-placeholder(someVar, path: "/assets/y.png")';
    expect(toPandocSource(src)).toBe('#figure(image("assets/y.png"), caption: [Figure])');
  });
  // The concatenation starts and ends with a quote, so an earlier parse
  // accepted it and wrote `Host " + host + " admin login` into the Word file
  // as if the author had typed it, while the PDF read correctly.
  it('treats a sandwich-concatenated caption as computed, not as its own text', () => {
    const src = '#image-placeholder("Host " + host + " admin login", path: "/assets/y.png")';
    expect(toPandocSource(src)).toBe('#figure(image("assets/y.png"), caption: [Figure])');
  });
});

describe('pandocSourceWarnings', () => {
  it('reports a slot whose caption is computed, naming its slot number and line', () => {
    const src = '#image-placeholder("Login bypass", path: "/assets/login.png")\n#image-placeholder(someVar, path: "/assets/y.png")\n';
    expect(pandocSourceWarnings(src)).toEqual([
      'Figure slot 2 (line 2): the caption is computed, so the Word file shows "Figure" instead.',
    ]);
  });
  it('reports a sandwich-concatenated caption, exactly once', () => {
    const src = '#image-placeholder("Host " + host + " admin login", path: "/assets/y.png")\n';
    expect(pandocSourceWarnings(src)).toEqual([
      'Figure slot 1 (line 1): the caption is computed, so the Word file shows "Figure" instead.',
    ]);
  });
  it('returns no warnings when every caption is a literal', () => {
    const src = '#image-placeholder("Login bypass", path: "/assets/login.png")\n';
    expect(pandocSourceWarnings(src)).toEqual([]);
  });
});
