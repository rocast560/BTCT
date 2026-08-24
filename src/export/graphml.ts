import type { GraphNode, GraphEdge } from '@/types';

/**
 * Export graph nodes and edges to valid GraphML XML.
 * Custom node/edge attributes are stored as <data> elements with defined keys.
 */
export function toGraphML(nodes: GraphNode[], edges: GraphEdge[], graphName: string): string {
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<graphml xmlns="http://graphml.graphstruct.org/xmlns"');
  lines.push('         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
  lines.push('         xsi:schemaLocation="http://graphml.graphstruct.org/xmlns http://graphml.graphstruct.org/xmlns/1.0/graphml.xsd">');
  lines.push('');

  // Key declarations for node attributes
  lines.push('  <key id="nodeType" for="node" attr.name="nodeType" attr.type="string"/>');
  lines.push('  <key id="label" for="node" attr.name="label" attr.type="string"/>');
  lines.push('  <key id="posX" for="node" attr.name="posX" attr.type="double"/>');
  lines.push('  <key id="posY" for="node" attr.name="posY" attr.type="double"/>');
  lines.push('  <key id="nodeData" for="node" attr.name="nodeData" attr.type="string"/>');
  lines.push('  <key id="linkedPageId" for="node" attr.name="linkedPageId" attr.type="string"/>');
  lines.push('  <key id="discoveredAt" for="node" attr.name="discoveredAt" attr.type="long"/>');

  // Key declarations for edge attributes
  lines.push('  <key id="edgeType" for="edge" attr.name="edgeType" attr.type="string"/>');
  lines.push('  <key id="edgeLabel" for="edge" attr.name="edgeLabel" attr.type="string"/>');
  lines.push('  <key id="edgeLinkedPageId" for="edge" attr.name="edgeLinkedPageId" attr.type="string"/>');
  lines.push('');

  lines.push(`  <graph id="${escapeXml(graphName)}" edgedefault="directed">`);

  for (const node of nodes) {
    lines.push(`    <node id="${escapeXml(node.id)}">`);
    lines.push(`      <data key="nodeType">${escapeXml(node.type)}</data>`);
    lines.push(`      <data key="label">${escapeXml(node.label)}</data>`);
    lines.push(`      <data key="posX">${node.position.x}</data>`);
    lines.push(`      <data key="posY">${node.position.y}</data>`);
    lines.push(`      <data key="nodeData">${escapeXml(JSON.stringify(node.data))}</data>`);
    lines.push(`      <data key="linkedPageId">${escapeXml(node.linkedPageId)}</data>`);
    lines.push(`      <data key="discoveredAt">${node.discoveredAt}</data>`);
    lines.push('    </node>');
  }

  for (const edge of edges) {
    lines.push(`    <edge id="${escapeXml(edge.id)}" source="${escapeXml(edge.sourceNodeId)}" target="${escapeXml(edge.targetNodeId)}">`);
    lines.push(`      <data key="edgeType">${escapeXml(edge.edgeType)}</data>`);
    lines.push(`      <data key="edgeLabel">${escapeXml(edge.label)}</data>`);
    if (edge.linkedPageId) {
      lines.push(`      <data key="edgeLinkedPageId">${escapeXml(edge.linkedPageId)}</data>`);
    }
    lines.push('    </edge>');
  }

  lines.push('  </graph>');
  lines.push('</graphml>');

  return lines.join('\n');
}

/**
 * Parse GraphML XML back into nodes and edges.
 */
export function fromGraphML(xml: string): { nodes: Omit<GraphNode, 'graphId' | 'createdAt' | 'updatedAt'>[]; edges: Omit<GraphEdge, 'graphId' | 'createdAt' | 'updatedAt'>[] } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const ns = 'http://graphml.graphstruct.org/xmlns';

  const nodeEls = doc.getElementsByTagNameNS(ns, 'node');
  const edgeEls = doc.getElementsByTagNameNS(ns, 'edge');

  const nodes: Omit<GraphNode, 'graphId' | 'createdAt' | 'updatedAt'>[] = [];
  const edges: Omit<GraphEdge, 'graphId' | 'createdAt' | 'updatedAt'>[] = [];

  for (let i = 0; i < nodeEls.length; i++) {
    const el = nodeEls[i]!;
    const id = el.getAttribute('id') ?? '';
    const data = getDataMap(el, ns);

    nodes.push({
      id,
      type: (data['nodeType'] ?? 'pivot') as GraphNode['type'],
      label: data['label'] ?? '',
      position: {
        x: parseFloat(data['posX'] ?? '0'),
        y: parseFloat(data['posY'] ?? '0'),
      },
      data: data['nodeData'] ? JSON.parse(data['nodeData']) : { description: '' },
      linkedPageId: data['linkedPageId'] ?? '',
      discoveredAt: parseInt(data['discoveredAt'] ?? '0', 10),
    });
  }

  for (let i = 0; i < edgeEls.length; i++) {
    const el = edgeEls[i]!;
    const id = el.getAttribute('id') ?? '';
    const source = el.getAttribute('source') ?? '';
    const target = el.getAttribute('target') ?? '';
    const data = getDataMap(el, ns);

    edges.push({
      id,
      sourceNodeId: source,
      targetNodeId: target,
      edgeType: (data['edgeType'] ?? 'Custom') as GraphEdge['edgeType'],
      label: data['edgeLabel'] ?? 'Custom',
      linkedPageId: data['edgeLinkedPageId'] ?? null,
    });
  }

  return { nodes, edges };
}

function getDataMap(el: Element, ns: string): Record<string, string> {
  const map: Record<string, string> = {};
  const dataEls = el.getElementsByTagNameNS(ns, 'data');
  for (let i = 0; i < dataEls.length; i++) {
    const d = dataEls[i]!;
    const key = d.getAttribute('key');
    if (key) {
      map[key] = d.textContent ?? '';
    }
  }
  return map;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
