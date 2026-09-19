// Client side of the server Typst export (server/typst/index.mjs). Covers
// the capability probe, the export call's blob/warnings decoding, and the
// pure warning rewrite used for display.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { displayWarning, exportOnServer, fetchExportCapabilities } from '@/lib/typst-export-api';

afterEach(() => vi.unstubAllGlobals());

describe('typst export api', () => {
  it('reports no capabilities when the route is missing (flag off)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    expect(await fetchExportCapabilities()).toEqual({ pdf: false, docx: false });
  });

  it('returns the blob and the baked count', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'X-Baked-Images': '2' },
    })));
    const out = await exportOnServer('w1', 'docx');
    expect(out.baked).toBe(2);
    expect(out.blob.size).toBe(3);
    expect(out.warnings).toEqual([]);
  });

  it('surfaces the server error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Typst error at main.typ:3: boom' }), { status: 422 })));
    await expect(exportOnServer('w1', 'pdf')).rejects.toThrow('Typst error at main.typ:3: boom');
  });

  it('decodes a well-formed warnings header into an array', async () => {
    const encoded = encodeURIComponent(JSON.stringify(['Figure slot 2 (line 14): the caption is computed, so the Word file shows "Figure" instead.']));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'X-Baked-Images': '0', 'X-Export-Warnings': encoded },
    })));
    const out = await exportOnServer('w1', 'docx');
    expect(out.warnings).toEqual(['Figure slot 2 (line 14): the caption is computed, so the Word file shows "Figure" instead.']);
  });

  it('never throws on a malformed warnings header (bad percent-escape)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'X-Baked-Images': '0', 'X-Export-Warnings': '%E0%A4%A' },
    })));
    const out = await exportOnServer('w1', 'docx');
    expect(out.warnings).toEqual([]);
  });

  it('never throws on a malformed warnings header (valid escape, not JSON)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'X-Baked-Images': '0', 'X-Export-Warnings': encodeURIComponent('not json') },
    })));
    const out = await exportOnServer('w1', 'docx');
    expect(out.warnings).toEqual([]);
  });

  it('rejects with the server sentence on a 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Another export is already queued. Try again in a moment.' }),
      { status: 429 },
    )));
    await expect(exportOnServer('w1', 'pdf')).rejects.toThrow('Another export is already queued. Try again in a moment.');
  });

  it('reports a network failure as "Could not reach the server."', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(exportOnServer('w1', 'pdf')).rejects.toThrow('Could not reach the server.');
  });

  describe('displayWarning', () => {
    it('rewrites the figure-slot form to lead with the line number', () => {
      expect(displayWarning('Figure slot 2 (line 14): the caption is computed, so the Word file shows "Figure" instead.'))
        .toBe('Line 14: the caption is computed, so the Word file shows "Figure" instead.');
    });

    it('leaves other text unchanged', () => {
      expect(displayWarning('One image could not be re-encoded and was skipped.'))
        .toBe('One image could not be re-encoded and was skipped.');
    });
  });
});
