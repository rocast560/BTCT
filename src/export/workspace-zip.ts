import JSZip from 'jszip';
import type { Workspace, Page, Graph, GraphNode, GraphEdge } from '@/types';
import { toGraphML } from './graphml';
import { pageToMarkdown } from './markdown';

interface WorkspaceExportData {
  workspace: Workspace;
  pages: Page[];
  graphs: Graph[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
}

/**
 * Export full workspace to a zip file.
 */
export async function exportWorkspaceZip(data: WorkspaceExportData): Promise<Blob> {
  const zip = new JSZip();

  // workspace.json
  zip.file('workspace.json', JSON.stringify(data.workspace, null, 2));

  // pages/
  const pagesFolder = zip.folder('pages')!;
  pagesFolder.file('_index.json', JSON.stringify(data.pages, null, 2));
  for (const page of data.pages) {
    pagesFolder.file(`${page.id}.md`, pageToMarkdown(page));
  }

  // graphs/
  const graphsFolder = zip.folder('graphs')!;
  graphsFolder.file('_index.json', JSON.stringify(data.graphs, null, 2));

  for (const graph of data.graphs) {
    const gFolder = graphsFolder.folder(graph.id)!;
    const nodes = data.graphNodes.filter((n) => n.graphId === graph.id);
    const edges = data.graphEdges.filter((e) => e.graphId === graph.id);

    gFolder.file('graph.json', JSON.stringify({ ...graph, nodes, edges }, null, 2));
    gFolder.file('graph.graphml', toGraphML(nodes, edges, graph.name));
    gFolder.file('nodes.json', JSON.stringify(nodes, null, 2));
    gFolder.file('edges.json', JSON.stringify(edges, null, 2));
  }

  return zip.generateAsync({ type: 'blob' });
}

/**
 * Import workspace from a zip file.
 */
export async function parseWorkspaceZip(blob: Blob): Promise<WorkspaceExportData> {
  const zip = await JSZip.loadAsync(blob);

  const wsJson = await zip.file('workspace.json')?.async('string');
  if (!wsJson) throw new Error('Invalid workspace zip: missing workspace.json');
  const workspace = JSON.parse(wsJson) as Workspace;

  const pagesJson = await zip.file('pages/_index.json')?.async('string');
  const pages = pagesJson ? (JSON.parse(pagesJson) as Page[]) : [];

  const graphsJson = await zip.file('graphs/_index.json')?.async('string');
  const graphs = graphsJson ? (JSON.parse(graphsJson) as Graph[]) : [];

  const graphNodes: GraphNode[] = [];
  const graphEdges: GraphEdge[] = [];

  for (const graph of graphs) {
    const nodesJson = await zip.file(`graphs/${graph.id}/nodes.json`)?.async('string');
    const edgesJson = await zip.file(`graphs/${graph.id}/edges.json`)?.async('string');
    if (nodesJson) graphNodes.push(...(JSON.parse(nodesJson) as GraphNode[]));
    if (edgesJson) graphEdges.push(...(JSON.parse(edgesJson) as GraphEdge[]));
  }

  return { workspace, pages, graphs, graphNodes, graphEdges };
}
