import { describe, it, expect } from 'vitest';
import {
  parseSitemapJson, normalizeSiteMap, normalizeNode, mergeNodeInputs, computeNodeKey,
} from '@/lib/sitemap-parser';

describe('computeNodeKey', () => {
  it('upcases the method and joins type|method|url', () => {
    expect(computeNodeKey('endpoint', 'https://x/a', 'post')).toBe('endpoint|POST|https://x/a');
    expect(computeNodeKey('page', 'https://x/', '')).toBe('page||https://x/');
  });
});

describe('normalizeNode', () => {
  it('computes a key when missing and coerces fields', () => {
    const n = normalizeNode({ type: 'api', url: 'https://x/api', method: 'get', status: '200' });
    expect(n).not.toBeNull();
    expect(n!.key).toBe('api|GET|https://x/api');
    expect(n!.status).toBe(200);
    expect(n!.type).toBe('api');
  });

  it('falls back to page for an unknown type', () => {
    expect(normalizeNode({ type: 'wat', url: 'https://x/' })!.type).toBe('page');
  });

  it('rejects a node with neither url nor key', () => {
    expect(normalizeNode({ type: 'page' })).toBeNull();
    expect(normalizeNode(null)).toBeNull();
  });
});

describe('normalizeSiteMap', () => {
  it('dedupes nodes by key and drops edges with missing endpoints', () => {
    const doc = normalizeSiteMap({
      target: 'https://x',
      nodes: [
        { type: 'root', url: 'https://x/' },
        { type: 'page', url: 'https://x/a', sources: ['crawl'] },
        { type: 'page', url: 'https://x/a', sources: ['probe'], tags: ['t'] },
      ],
      edges: [
        { source: 'root||https://x/', target: 'page||https://x/a', kind: 'link' },
        { source: 'root||https://x/', target: 'page||https://x/a', kind: 'link' }, // dup
        { source: 'root||https://x/', target: 'missing', kind: 'link' },           // dangling
      ],
    });
    expect(doc.nodes).toHaveLength(2);
    const a = doc.nodes.find((n) => n.url === 'https://x/a')!;
    expect(a.sources.sort()).toEqual(['crawl', 'probe']);
    expect(a.tags).toEqual(['t']);
    expect(doc.edges).toHaveLength(1);
  });

  it('defaults scannedAt to now when absent or invalid', () => {
    const before = Date.now();
    const doc = normalizeSiteMap({ target: 'https://x', nodes: [], edges: [] });
    expect(doc.scannedAt).toBeGreaterThanOrEqual(before);
  });

  it('keeps a provided scannedAt', () => {
    expect(normalizeSiteMap({ target: 'https://x', scannedAt: 123, nodes: [] }).scannedAt).toBe(123);
  });
});

describe('parseSitemapJson', () => {
  it('throws on invalid JSON', () => {
    expect(() => parseSitemapJson('{not json')).toThrow(/invalid json/i);
  });

  it('parses a valid document', () => {
    const doc = parseSitemapJson(JSON.stringify({
      version: 1, target: 'https://x', nodes: [{ type: 'root', url: 'https://x/' }], edges: [],
    }));
    expect(doc.target).toBe('https://x');
    expect(doc.nodes).toHaveLength(1);
  });
});

describe('mergeNodeInputs', () => {
  it('unions list fields and prefers the newer status/title', () => {
    const a = normalizeNode({ type: 'page', url: 'https://x/a', status: 200, sources: ['crawl'], tags: ['x'] })!;
    const b = normalizeNode({ type: 'page', url: 'https://x/a', status: 301, title: 'A', sources: ['probe'], tags: ['y'] })!;
    const m = mergeNodeInputs(a, b);
    expect(m.status).toBe(301);
    expect(m.title).toBe('A');
    expect(m.sources.sort()).toEqual(['crawl', 'probe']);
    expect(m.tags.sort()).toEqual(['x', 'y']);
  });
});
