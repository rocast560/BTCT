import type { GraphNode, GraphEdge, Page } from '@/types';
import { toGraphML } from './graphml';
import { pageToMarkdown } from './markdown';

/**
 * Attack path bundle: custom XML containing metadata, GraphML of the path, and linked pages as Markdown.
 */
export function toAttackPathBundle(
  pathNodeIds: string[],
  allNodes: GraphNode[],
  allEdges: GraphEdge[],
  linkedPages: Page[],
  metadata: { name: string; date: string; description: string }
): string {
  const pathNodes = allNodes.filter((n) => pathNodeIds.includes(n.id));
  const pathEdges = allEdges.filter(
    (e) => pathNodeIds.includes(e.sourceNodeId) && pathNodeIds.includes(e.targetNodeId)
  );

  const graphml = toGraphML(pathNodes, pathEdges, metadata.name);
  const pagesMarkdown = linkedPages.map((p) => ({
    id: p.id,
    title: p.title,
    markdown: pageToMarkdown(p),
  }));

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<attack-path-bundle>');
  lines.push('  <metadata>');
  lines.push(`    <name>${escapeXml(metadata.name)}</name>`);
  lines.push(`    <date>${escapeXml(metadata.date)}</date>`);
  lines.push(`    <description>${escapeXml(metadata.description)}</description>`);
  lines.push(`    <nodeCount>${pathNodes.length}</nodeCount>`);
  lines.push(`    <edgeCount>${pathEdges.length}</edgeCount>`);
  lines.push('  </metadata>');
  lines.push('  <graph>');
  lines.push(`    <![CDATA[${graphml}]]>`);
  lines.push('  </graph>');
  lines.push('  <linked-pages>');
  for (const p of pagesMarkdown) {
    lines.push(`    <page id="${escapeXml(p.id)}" title="${escapeXml(p.title)}">`);
    lines.push(`      <![CDATA[${p.markdown}]]>`);
    lines.push('    </page>');
  }
  lines.push('  </linked-pages>');
  lines.push('</attack-path-bundle>');

  return lines.join('\n');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
