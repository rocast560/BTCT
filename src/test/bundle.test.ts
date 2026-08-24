import { describe, it, expect } from 'vitest';
import { toAttackPathBundle } from '@/export/bundle';
import { fixtureNodes, fixtureEdges, fixturePages } from './fixtures';

describe('Attack path bundle export', () => {
  it('produces valid XML with metadata, graph, and linked pages', () => {
    const pathNodeIds = [fixtureNodes[0]!.id, fixtureNodes[1]!.id, fixtureNodes[2]!.id];
    const xml = toAttackPathBundle(
      pathNodeIds,
      fixtureNodes,
      fixtureEdges,
      fixturePages,
      { name: 'Test Path', date: '2026-04-18', description: 'A test attack path' }
    );

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<attack-path-bundle>');
    expect(xml).toContain('<name>Test Path</name>');
    expect(xml).toContain('<nodeCount>3</nodeCount>');
    expect(xml).toContain('<edgeCount>2</edgeCount>');
    expect(xml).toContain('<graph>');
    expect(xml).toContain('<linked-pages>');
    expect(xml).toContain('</attack-path-bundle>');
  });

  it('embeds GraphML in CDATA', () => {
    const pathNodeIds = [fixtureNodes[0]!.id];
    const xml = toAttackPathBundle(pathNodeIds, fixtureNodes, fixtureEdges, [fixturePages[0]!], {
      name: 'Mini Path',
      date: '2026-04-18',
      description: 'Single node path',
    });

    expect(xml).toContain('<![CDATA[<?xml version="1.0"');
    expect(xml).toContain('</graph>');
  });
});
