import { describe, it, expect } from 'vitest';
import { filterDocxImages, STAGED_IMAGE } from '../../server/typst/docx-ast.mjs';

// Pandoc has already evaluated the report by the time this runs, so a target
// here is the final string: `#image("./" + "../x.png")` arrives as
// "./../x.png" and `#image(u)` arrives as the URL. That is why the AST is
// filtered and the source text is not.

const image = (target: string) => ({ t: 'Image', c: [['', [], []], [{ t: 'Str', c: 'cap' }], [target, '']] });
const doc = (blocks: unknown[]) => ({ 'pandoc-api-version': [1, 23, 1, 2], meta: {}, blocks });
const always = () => true;

function targets(ast: unknown): string[] {
  const out: string[] = [];
  (function walk(n: any) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n.t === 'Image') out.push(n.c?.[2]?.[0]);
      Object.values(n).forEach(walk);
    }
  })(ast);
  return out;
}

describe('STAGED_IMAGE', () => {
  it('matches exactly one staged asset name', () => {
    expect(STAGED_IMAGE.test('assets/shot.png')).toBe(true);
    expect(STAGED_IMAGE.test('assets/a b.png')).toBe(true);
    for (const bad of ['assets/../x.png', 'assets/sub/x.png', 'assets\\x.png', '../assets/x.png', 'assets/', 'shot.png', '/assets/x.png', 'http://x/assets/y.png']) {
      expect(STAGED_IMAGE.test(bad), bad).toBe(false);
    }
  });
});

describe('filterDocxImages', () => {
  it('keeps a staged image that exists', () => {
    const ast = doc([{ t: 'Para', c: [image('assets/shot.png')] }]);
    const out = filterDocxImages(ast, always);
    expect(targets(out.ast)).toEqual(['assets/shot.png']);
    expect(out.warnings).toEqual([]);
  });

  it('replaces a URL target and warns', () => {
    const out = filterDocxImages(doc([{ t: 'Para', c: [image('http://127.0.0.1:8123/ssrf.png')] }]), always);
    expect(targets(out.ast)).toEqual([]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('http://127.0.0.1:8123/ssrf.png');
    // The placeholder is split into words because that is how pandoc's own
    // Str/Space inlines work.
    expect(JSON.stringify(out.ast)).toContain('[image');
    expect(JSON.stringify(out.ast)).toContain('included]');
  });

  it('replaces a climb, an absolute path and a UNC path', () => {
    for (const bad of ['./../outside.png', '../outside.png', 'C:/Windows/win.ini', '/etc/passwd', '\\\\host\\share\\x.png', 'assets/../../x']) {
      const out = filterDocxImages(doc([{ t: 'Para', c: [image(bad)] }]), always);
      expect(targets(out.ast), bad).toEqual([]);
      expect(out.warnings, bad).toHaveLength(1);
    }
  });

  it('replaces a staged-looking target that is not actually there', () => {
    const out = filterDocxImages(doc([{ t: 'Para', c: [image('assets/ghost.png')] }]), () => false);
    expect(targets(out.ast)).toEqual([]);
    expect(out.warnings[0]).toContain('assets/ghost.png');
  });

  it('reaches images nested in a figure, a table cell, a link and a list', () => {
    const ast = doc([
      { t: 'Figure', c: [['', [], []], [null, []], [{ t: 'Plain', c: [image('http://evil/1.png')] }]] },
      { t: 'Table', c: [['', [], []], [null, []], [], [{ t: 'TableBody', c: [[{ t: 'Row', c: [['', [], []], [{ t: 'Cell', c: [['', [], []], [{ t: 'Plain', c: [image('../2.png')] }]] }]] }]] }]] },
      { t: 'Para', c: [{ t: 'Link', c: [['', [], []], [image('C:/3.png')], ['http://x', '']] }] },
      { t: 'BulletList', c: [[{ t: 'Plain', c: [image('assets/ok.png')] }]] },
      { t: 'BlockQuote', c: [{ t: 'Plain', c: [image('assets/ok2.png')] }] },
    ]);
    const out = filterDocxImages(ast, always);
    expect(targets(out.ast).sort()).toEqual(['assets/ok.png', 'assets/ok2.png']);
    expect(out.warnings).toHaveLength(3);
  });

  it('drops raw blocks and raw inlines', () => {
    // Pandoc's Typst reader does not produce these today, checked against
    // `#raw(..., lang: "openxml")`, fences and `#html.elem`. If one ever
    // arrived with format openxml, the docx writer would paste it into
    // document.xml verbatim, and a field code there can make Word fetch a
    // URL when the person who was sent the report opens it.
    const ast = doc([
      { t: 'RawBlock', c: ['openxml', '<w:fldSimple w:instr="INCLUDEPICTURE \\"http://evil/x.png\\""/>'] },
      { t: 'Para', c: [{ t: 'Str', c: 'before' }, { t: 'RawInline', c: ['openxml', '<w:t>x</w:t>'] }, { t: 'Str', c: 'after' }] },
    ]);
    const out = filterDocxImages(ast, always);
    const json = JSON.stringify(out.ast);
    expect(json).not.toContain('RawBlock');
    expect(json).not.toContain('RawInline');
    expect(json).not.toContain('fldSimple');
    expect(json).toContain('before');
    expect(json).toContain('after');
  });

  it('drops a raw node wherever it is nested', () => {
    const ast = doc([
      { t: 'BlockQuote', c: [{ t: 'RawBlock', c: ['openxml', '<w:p/>'] }] },
      { t: 'Para', c: [{ t: 'Link', c: [['', [], []], [{ t: 'RawInline', c: ['html', '<img src="http://evil/x">'] }], ['http://x', '']] }] },
    ]);
    const json = JSON.stringify(filterDocxImages(ast, always).ast);
    expect(json).not.toContain('Raw');
    expect(json).not.toContain('evil');
  });

  it('leaves a node alone that merely contains the word Image', () => {
    const ast = doc([{ t: 'Para', c: [{ t: 'Str', c: 'Image' }, { t: 'Code', c: [['', [], []], 'Image'] }] }]);
    expect(filterDocxImages(ast, always)).toEqual({ ast, warnings: [] });
  });

  it('does not mutate the AST it is given', () => {
    const ast = doc([{ t: 'Para', c: [image('http://evil/1.png')] }]);
    const before = JSON.stringify(ast);
    filterDocxImages(ast, always);
    expect(JSON.stringify(ast)).toBe(before);
  });

  it('fails closed on a malformed image node', () => {
    const out = filterDocxImages(doc([{ t: 'Para', c: [{ t: 'Image' }, { t: 'Image', c: [['', [], []], [], [42, '']] }] }]), always);
    expect(JSON.stringify(out.ast)).not.toContain('"Image"');
    expect(out.warnings).toHaveLength(2);
  });

  it('truncates a very long target in the warning', () => {
    const long = `http://x/${'a'.repeat(300)}.png`;
    const out = filterDocxImages(doc([{ t: 'Para', c: [image(long)] }]), always);
    expect(out.warnings[0]!.length).toBeLessThan(160);
  });
});
