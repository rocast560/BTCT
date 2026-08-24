import { describe, it, expect } from 'vitest';
import { toGraphML, fromGraphML } from '@/export/graphml';
import { fixtureNodes, fixtureEdges } from './fixtures';

describe('GraphML export', () => {
  it('produces valid XML with key declarations', () => {
    const xml = toGraphML(fixtureNodes, fixtureEdges, 'TestGraph');

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<graphml');
    expect(xml).toContain('<key id="nodeType"');
    expect(xml).toContain('<key id="edgeType"');
    expect(xml).toContain('edgedefault="directed"');
  });

  it('includes all nodes and edges', () => {
    const xml = toGraphML(fixtureNodes, fixtureEdges, 'TestGraph');

    expect(xml).toContain(`<node id="${fixtureNodes[0]!.id}">`);
    expect(xml).toContain(`<node id="${fixtureNodes[1]!.id}">`);
    expect(xml).toContain(`<node id="${fixtureNodes[2]!.id}">`);
    expect(xml).toContain(`<edge id="${fixtureEdges[0]!.id}"`);
    expect(xml).toContain(`<edge id="${fixtureEdges[1]!.id}"`);
  });

  it('stores custom data in <data> elements', () => {
    const xml = toGraphML(fixtureNodes, fixtureEdges, 'TestGraph');

    expect(xml).toContain('<data key="nodeType">host</data>');
    expect(xml).toContain('<data key="label">WEB-01</data>');
    expect(xml).toContain('<data key="edgeType">AdminTo</data>');
  });

  it('roundtrips through fromGraphML', () => {
    const xml = toGraphML(fixtureNodes, fixtureEdges, 'TestGraph');
    const { nodes, edges } = fromGraphML(xml);

    expect(nodes).toHaveLength(3);
    expect(edges).toHaveLength(2);

    const n1 = nodes.find((n) => n.id === fixtureNodes[0]!.id);
    expect(n1).toBeDefined();
    expect(n1!.type).toBe('host');
    expect(n1!.label).toBe('WEB-01');

    const e1 = edges.find((e) => e.id === fixtureEdges[0]!.id);
    expect(e1).toBeDefined();
    expect(e1!.edgeType).toBe('AdminTo');
  });
});
