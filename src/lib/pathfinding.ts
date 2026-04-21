/**
 * Dijkstra-based shortest path on unweighted directed graph.
 * Returns array of node IDs and edge IDs along the path.
 */
export function findShortestPath(
  nodeIds: string[],
  edges: { id: string; source: string; target: string }[],
  startId: string,
  endId: string
): string[] {
  // Build adjacency list
  const adj = new Map<string, { nodeId: string; edgeId: string }[]>();
  for (const nid of nodeIds) {
    adj.set(nid, []);
  }
  for (const edge of edges) {
    const list = adj.get(edge.source);
    if (list) list.push({ nodeId: edge.target, edgeId: edge.id });
    // Also add reverse for undirected path finding
    const rlist = adj.get(edge.target);
    if (rlist) rlist.push({ nodeId: edge.source, edgeId: edge.id });
  }

  // BFS (all weights = 1, so BFS = Dijkstra)
  const visited = new Set<string>();
  const prev = new Map<string, { nodeId: string; edgeId: string }>();
  const queue: string[] = [startId];
  visited.add(startId);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === endId) break;

    const neighbors = adj.get(current) ?? [];
    for (const { nodeId, edgeId } of neighbors) {
      if (!visited.has(nodeId)) {
        visited.add(nodeId);
        prev.set(nodeId, { nodeId: current, edgeId });
        queue.push(nodeId);
      }
    }
  }

  // Reconstruct path
  if (!prev.has(endId) && startId !== endId) return [];

  const pathNodeIds: string[] = [];
  const pathEdgeIds: string[] = [];
  let current = endId;

  while (current !== startId) {
    pathNodeIds.unshift(current);
    const p = prev.get(current);
    if (!p) break;
    pathEdgeIds.unshift(p.edgeId);
    current = p.nodeId;
  }
  pathNodeIds.unshift(startId);

  return [...pathNodeIds, ...pathEdgeIds];
}
