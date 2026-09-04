import { describe, it, expect } from 'vitest';
import {
  isBlockedIPv4, isBlockedIPv6, isBlockedHostLiteral, assertScanTargetAllowed, normalizeSitemapDoc,
} from '../../server/webrecon-scope.mjs';

describe('anti-SSRF scope guard', () => {
  it('blocks private / loopback / link-local / metadata IPv4', () => {
    expect(isBlockedIPv4(127, 0, 0, 1)).toBe(true);       // loopback
    expect(isBlockedIPv4(10, 0, 0, 5)).toBe(true);        // private
    expect(isBlockedIPv4(172, 16, 0, 1)).toBe(true);      // private
    expect(isBlockedIPv4(172, 31, 255, 255)).toBe(true);  // private edge
    expect(isBlockedIPv4(192, 168, 1, 1)).toBe(true);     // private
    expect(isBlockedIPv4(169, 254, 169, 254)).toBe(true); // cloud metadata
    expect(isBlockedIPv4(100, 64, 0, 1)).toBe(true);      // CGNAT
    expect(isBlockedIPv4(0, 0, 0, 0)).toBe(true);
    expect(isBlockedIPv4(224, 0, 0, 1)).toBe(true);       // multicast
  });

  it('allows ordinary public IPv4', () => {
    expect(isBlockedIPv4(8, 8, 8, 8)).toBe(false);
    expect(isBlockedIPv4(93, 184, 216, 34)).toBe(false); // example.com
    expect(isBlockedIPv4(172, 15, 0, 1)).toBe(false);    // just below private range
    expect(isBlockedIPv4(172, 32, 0, 1)).toBe(false);    // just above private range
  });

  it('blocks loopback / ULA / link-local IPv6', () => {
    expect(isBlockedIPv6('::1')).toBe(true);
    expect(isBlockedIPv6('fe80::1')).toBe(true);
    expect(isBlockedIPv6('fc00::1')).toBe(true);
    expect(isBlockedIPv6('fd12:3456::1')).toBe(true);
    expect(isBlockedIPv6('::ffff:127.0.0.1')).toBe(true); // mapped loopback
    expect(isBlockedIPv6('2606:4700:4700::1111')).toBe(false); // public
  });

  it('blocks localhost and internal-looking hostnames', () => {
    expect(isBlockedHostLiteral('localhost')).toBe(true);
    expect(isBlockedHostLiteral('db.internal')).toBe(true);
    expect(isBlockedHostLiteral('printer.local')).toBe(true);
    expect(isBlockedHostLiteral('127.0.0.1')).toBe(true);
    expect(isBlockedHostLiteral('example.com')).toBe(false);
    expect(isBlockedHostLiteral('')).toBe(true);
  });

  it('assertScanTargetAllowed rejects internal targets and bad schemes', () => {
    expect(() => assertScanTargetAllowed('http://127.0.0.1/')).toThrow(/not allowed/i);
    expect(() => assertScanTargetAllowed('http://169.254.169.254/latest/meta-data/')).toThrow(/not allowed/i);
    expect(() => assertScanTargetAllowed('http://10.0.0.5/')).toThrow(/not allowed/i);
    expect(() => assertScanTargetAllowed('ftp://example.com/')).toThrow(/http/i);
    expect(() => assertScanTargetAllowed('not a url')).toThrow(/invalid/i);
  });

  it('assertScanTargetAllowed accepts a public target', () => {
    const u = assertScanTargetAllowed('https://example.com/app');
    expect(u.hostname).toBe('example.com');
  });
});

describe('normalizeSitemapDoc (server twin)', () => {
  it('dedupes nodes and drops dangling edges', () => {
    const doc = normalizeSitemapDoc({
      target: 'https://x',
      nodes: [
        { type: 'root', url: 'https://x/' },
        { type: 'page', url: 'https://x/a' },
        { type: 'page', url: 'https://x/a' },
      ],
      edges: [
        { source: 'root||https://x/', target: 'page||https://x/a', kind: 'link' },
        { source: 'root||https://x/', target: 'nope', kind: 'link' },
      ],
    });
    expect(doc.nodes).toHaveLength(2);
    expect(doc.edges).toHaveLength(1);
  });

  it('coerces an unknown node type to page and a bad edge kind to link', () => {
    const doc = normalizeSitemapDoc({
      target: 'https://x',
      nodes: [{ type: 'weird', url: 'https://x/' }, { type: 'page', url: 'https://x/a' }],
      edges: [{ source: 'page||https://x/', target: 'page||https://x/a', kind: 'bogus' }],
    });
    expect(doc.nodes[0]!.type).toBe('page');
    expect(doc.edges[0]!.kind).toBe('link');
  });

  it('throws on a non-object', () => {
    expect(() => normalizeSitemapDoc(null)).toThrow();
  });
});
