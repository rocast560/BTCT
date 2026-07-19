import { describe, it, expect } from 'vitest';
import { autoLayout, DEFAULT_LAYOUT_OPTIONS } from '@/lib/auto-layout';
import type { Node, Edge } from '@xyflow/react';

describe('autoLayout', () => {
  const node = (id: string, type: string): Node => ({
    id, type, position: { x: 0, y: 0 }, data: {},
  });
  const edge = (id: string, source: string, target: string, label?: string): Edge => ({
    id, source, target, data: label ? { label } : undefined,
  });

  it('returns nodes with computed positions', () => {
    const nodes = [node('a', 'host'), node('b', 'service'), node('c', 'finding')];
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')];
    const out = autoLayout(nodes, edges, 'TB');
    expect(out).toHaveLength(3);
    out.forEach((n) => {
      expect(typeof n.position.x).toBe('number');
      expect(typeof n.position.y).toBe('number');
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    });
    // Connected nodes should be vertically separated when direction is TB.
    const a = out.find((n) => n.id === 'a')!;
    const b = out.find((n) => n.id === 'b')!;
    expect(b.position.y).not.toBe(a.position.y);
  });

  it('lays out left-to-right when direction is LR', () => {
    const nodes = [node('a', 'host'), node('b', 'service')];
    const edges = [edge('e1', 'a', 'b')];
    const out = autoLayout(nodes, edges, 'LR');
    const a = out.find((n) => n.id === 'a')!;
    const b = out.find((n) => n.id === 'b')!;
    expect(b.position.x).not.toBe(a.position.x);
  });

  it('handles unknown node types using the default size', () => {
    const out = autoLayout([node('a', 'mystery')], []);
    expect(out).toHaveLength(1);
    expect(Number.isFinite(out[0]!.position.x)).toBe(true);
  });

  it('exposes sane default layout options', () => {
    expect(DEFAULT_LAYOUT_OPTIONS.nodesep).toBeGreaterThan(0);
    expect(DEFAULT_LAYOUT_OPTIONS.ranksep).toBeGreaterThan(0);
    expect(DEFAULT_LAYOUT_OPTIONS.edgesep).toBeGreaterThan(0);
  });
});
