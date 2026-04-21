import { useState } from 'react';
import { useAppStore } from '@/stores';
import {
  pageToMarkdown,
  toGraphML,
  exportWorkspaceZip,
  parseWorkspaceZip,
  fromGraphML,
} from '@/export';
import { db, pageRepo, graphRepo, graphNodeRepo, graphEdgeRepo, workspaceRepo } from '@/db';
import JSZip from 'jszip';
import { Download, Upload, X } from 'lucide-react';

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pages, graphs, graphNodes, graphEdges, activeWorkspaceId, loadWorkspaces, loadGraphs, setActiveWorkspace } =
    useAppStore();
  const [status, setStatus] = useState('');

  if (!open) return null;

  const download = (content: string, filename: string, mime = 'text/plain') => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPagesMarkdown = async () => {
    const visiblePages = pages.filter((p) => !p.isGraphPage);
    if (visiblePages.length === 0) { setStatus('No pages to export'); return; }
    if (visiblePages.length === 1 && visiblePages[0]) {
      download(pageToMarkdown(visiblePages[0]), `${visiblePages[0].title}.md`);
    } else {
      const zip = new JSZip();
      for (const page of visiblePages) {
        zip.file(`${page.title.replace(/[/\\?%*:|"<>]/g, '_')}.md`, pageToMarkdown(page));
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, 'pages.zip');
    }
    setStatus('Pages exported');
  };

  const handleExportGraphML = (graphId: string) => {
    const graph = graphs.find((g) => g.id === graphId);
    if (!graph) return;
    const nodes = graphNodes.filter((n) => n.graphId === graphId);
    const edges = graphEdges.filter((e) => e.graphId === graphId);
    const xml = toGraphML(nodes, edges, graph.name);
    download(xml, `${graph.name}.graphml`, 'application/xml');
    setStatus('GraphML exported');
  };

  const handleExportGraphJSON = async (graphId: string) => {
    const graph = graphs.find((g) => g.id === graphId);
    if (!graph) return;
    const nodes = graphNodes.filter((n) => n.graphId === graphId);
    const edges = graphEdges.filter((e) => e.graphId === graphId);

    // Fetch linked pages (isGraphPage nodes are not in the store's pages array)
    const linkedPages = await Promise.all(nodes.map((n) => pageRepo.getById(n.linkedPageId)));
    const pageMap = new Map(linkedPages.filter(Boolean).map((p) => [p!.id, p!]));

    const data = {
      nodes: nodes.map((n) => {
        const linkedPage = pageMap.get(n.linkedPageId);
        return {
          id: n.id,
          type: n.type,
          label: n.label,
          position: n.position,
          discoveredAt: n.discoveredAt,
          data: n.data,
          notes: linkedPage ? pageToMarkdown(linkedPage) : '',
        };
      }),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.sourceNodeId,
        target: e.targetNodeId,
        data: { label: e.label, edgeType: e.edgeType },
      })),
    };
    download(JSON.stringify(data, null, 2), `${graph.name}.json`, 'application/json');
    setStatus('JSON exported');
  };

  const handleExportWorkspace = async () => {
    if (!activeWorkspaceId) return;
    const workspace = await workspaceRepo.getById(activeWorkspaceId);
    if (!workspace) return;
    const allPages = await pageRepo.getByWorkspace(activeWorkspaceId, true);
    const allGraphs = await graphRepo.getByWorkspace(activeWorkspaceId);
    const allNodes = (await Promise.all(allGraphs.map((g) => graphNodeRepo.getByGraph(g.id)))).flat();
    const allEdges = (await Promise.all(allGraphs.map((g) => graphEdgeRepo.getByGraph(g.id)))).flat();

    const blob = await exportWorkspaceZip({ workspace, pages: allPages, graphs: allGraphs, graphNodes: allNodes, graphEdges: allEdges });
    downloadBlob(blob, `${workspace.name}.zip`);
    setStatus('Workspace exported');
  };

  const handleImportGraphML = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.graphml';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !activeWorkspaceId) return;
      const text = await file.text();
      const { nodes, edges } = fromGraphML(text);

      // Create new graph
      const graph = await graphRepo.create({ workspaceId: activeWorkspaceId, name: file.name.replace('.graphml', '') });
      const now = Date.now();

      for (const node of nodes) {
        const page = await pageRepo.create({
          workspaceId: activeWorkspaceId,
          parentId: null,
          title: node.label,
          isGraphPage: true,
        });
        await db.graphNodes.add({
          ...node,
          graphId: graph.id,
          linkedPageId: page.id,
          createdAt: now,
          updatedAt: now,
        });
      }

      for (const edge of edges) {
        await db.graphEdges.add({
          ...edge,
          graphId: graph.id,
          createdAt: now,
          updatedAt: now,
        });
      }

      await loadGraphs();
      setStatus('GraphML imported');
    };
    input.click();
  };

  const handleImportWorkspace = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = await parseWorkspaceZip(file);
        const now = Date.now();

        await db.workspaces.add({ ...data.workspace, createdAt: now, updatedAt: now });
        for (const page of data.pages) {
          await db.pages.add({ ...page, createdAt: now, updatedAt: now });
        }
        for (const graph of data.graphs) {
          await db.graphs.add({ ...graph, createdAt: now, updatedAt: now });
        }
        for (const node of data.graphNodes) {
          await db.graphNodes.add({ ...node, createdAt: now, updatedAt: now });
        }
        for (const edge of data.graphEdges) {
          await db.graphEdges.add({ ...edge, createdAt: now, updatedAt: now });
        }

        await loadWorkspaces();
        setActiveWorkspace(data.workspace.id);
        setStatus('Workspace imported');
      } catch (err) {
        setStatus(`Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    };
    input.click();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="fixed inset-0 bg-black/50" />
      <div className="relative z-10 w-[500px] border border-[hsl(var(--border))] bg-[hsl(var(--popover))] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Export / Import</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><X size={16} /></button>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-[hsl(var(--muted-foreground))]">Export</h3>
          <button onClick={() => void handleExportPagesMarkdown()} className="flex w-full items-center gap-2 rounded border border-[hsl(var(--border))] px-3 py-2 text-sm hover:bg-[hsl(var(--accent))]">
            <Download size={14} /> All Pages → Markdown
          </button>

          {graphs.map((g) => (
            <div key={g.id} className="flex gap-1">
              <button onClick={() => handleExportGraphML(g.id)} className="flex flex-1 items-center gap-2 rounded border border-[hsl(var(--border))] px-3 py-2 text-sm hover:bg-[hsl(var(--accent))]">
                <Download size={14} /> {g.name} → GraphML
              </button>
              <button onClick={() => void handleExportGraphJSON(g.id)} className="flex items-center gap-2 rounded border border-[hsl(var(--border))] px-3 py-2 text-sm hover:bg-[hsl(var(--accent))]">
                JSON
              </button>
            </div>
          ))}

          <button onClick={() => void handleExportWorkspace()} className="flex w-full items-center gap-2 rounded border border-[hsl(var(--border))] px-3 py-2 text-sm hover:bg-[hsl(var(--accent))]">
            <Download size={14} /> Full Workspace → ZIP
          </button>

          <div className="border-t border-[hsl(var(--border))] pt-3">
            <h3 className="text-sm font-semibold text-[hsl(var(--muted-foreground))] mb-2">Import</h3>
            <div className="flex gap-2">
              <button onClick={handleImportGraphML} className="flex flex-1 items-center gap-2 rounded border border-[hsl(var(--border))] px-3 py-2 text-sm hover:bg-[hsl(var(--accent))]">
                <Upload size={14} /> GraphML
              </button>
              <button onClick={handleImportWorkspace} className="flex flex-1 items-center gap-2 rounded border border-[hsl(var(--border))] px-3 py-2 text-sm hover:bg-[hsl(var(--accent))]">
                <Upload size={14} /> Workspace ZIP
              </button>
            </div>
          </div>
        </div>

        {status && <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">{status}</p>}
      </div>
    </div>
  );
}
