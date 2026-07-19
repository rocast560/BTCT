import { describe, it, expect } from 'vitest';
import { findShortestPath } from '@/lib/pathfinding';

describe('Pathfinding', () => {
  const nodeIds = ['A', 'B', 'C', 'D', 'E'];
  const edges = [
    { id: 'e1', source: 'A', target: 'B' },
    { id: 'e2', source: 'B', target: 'C' },
    { id: 'e3', source: 'A', target: 'D' },
    { id: 'e4', source: 'D', target: 'C' },
    { id: 'e5', source: 'C', target: 'E' },
  ];

  it('finds shortest path between two nodes', () => {
    const result = findShortestPath(nodeIds, edges, 'A', 'C');
    // Should include node IDs and edge IDs
    expect(result).toContain('A');
    expect(result).toContain('C');
    // Path A -> B -> C is length 2 (same as A -> D -> C)
    // At least one of these edges should be present
    const hasAB = result.includes('e1') && result.includes('e2');
    const hasADC = result.includes('e3') && result.includes('e4');
    expect(hasAB || hasADC).toBe(true);
  });

  it('finds path to endpoint', () => {
    const result = findShortestPath(nodeIds, edges, 'A', 'E');
    expect(result).toContain('A');
    expect(result).toContain('E');
    expect(result).toContain('e5');
  });

  it('returns empty array when no path exists', () => {
    const result = findShortestPath(['X', 'Y'], [], 'X', 'Y');
    expect(result).toEqual([]);
  });

  it('handles same start and end', () => {
    const result = findShortestPath(nodeIds, edges, 'A', 'A');
    expect(result).toEqual(['A']);
  });
});
