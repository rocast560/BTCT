import { useState } from 'react';
import { useAppStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import {
  pageToMarkdown,
  toGraphML,
  exportWorkspaceZip,
  parseWorkspaceZip,
  collectPageYjsUpdates,
  applyImportedPageYjsUpdate,
  fromGraphML,
} from '@/export';
import {
  db,
  pageRepo,
  graphRepo,
  graphNodeRepo,
  graphEdgeRepo,
  workspaceRepo,
  changeLogRepo,
  nmapScanRepo,
  nmapMachineRepo,
  attackChainRepo,
} from '@/db';
import JSZip from 'jszip';
import { Download, Upload, X } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

type ImportMode = 'new' | 'replace';

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    pages, graphs, graphNodes, graphEdges, activeWorkspaceId,
    loadWorkspaces, loadGraphs, setActiveWorkspace, loadPages, loadChangeLogs, loadNmapScans, loadAttackChains,
  } = useAppStore(useShallow((s) => ({
    pages: s.pages,
    graphs: s.graphs,
    graphNodes: s.graphNodes,
    graphEdges: s.graphEdges,
    activeWorkspaceId: s.activeWorkspaceId,
    loadWorkspaces: s.loadWorkspaces,
    loadGraphs: s.loadGraphs,
    setActiveWorkspace: s.setActiveWorkspace,
    loadPages: s.loadPages,
    loadChangeLogs: s.loadChangeLogs,
    loadNmapScans: s.loadNmapScans,
    loadAttackChains: s.loadAttackChains,
  })));
  const [status, setStatus] = useState('');
  const [importMode, setImportMode] = useState<ImportMode>('new');

  if (!open) return null;

  const download = (content: string, filename: string, mime = 'text/plain') => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
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
    download(toGraphML(nodes, edges, graph.name), `${graph.name}.graphml`, 'application/xml');
    setStatus('GraphML exported');
  };

  const handleExportGraphJSON = async (graphId: string) => {
    const graph = graphs.find((g) => g.id === graphId);
    if (!graph) return;
    const nodes = graphNodes.filter((n) => n.graphId === graphId);
    const edges = graphEdges.filter((e) => e.graphId === graphId);
    const linkedPages = await Promise.all(nodes.map((n) => pageRepo.getById(n.linkedPageId)));
    const pageMap = new Map(linkedPages.filter(Boolean).map((p) => [p!.id, p!]));
    const data = {
      nodes: nodes.map((n) => {
        const linkedPage = pageMap.get(n.linkedPageId);
        return {
          id: n.id, type: n.type, label: n.label, position: n.position,
          discoveredAt: n.discoveredAt, data: n.data,
          notes: linkedPage ? pageToMarkdown(linkedPage) : '',
        };
      }),
      edges: edges.map((e) => ({
        id: e.id, source: e.sourceNodeId, target: e.targetNodeId,
        data: { label: e.label, edgeType: e.edgeType },
      })),
    };
    download(JSON.stringify(data, null, 2), `${graph.name}.json`, 'application/json');
    setStatus('JSON exported');
  };

  // Lossless workspace export. Captures every entity tied to the workspace
  // plus the raw Yjs binary state of every reachable page body.
  const handleExportWorkspace = async () => {
    if (!activeWorkspaceId) { setStatus('No active workspace'); return; }
    setStatus('Gathering workspace…');
    try {
      const workspace = await workspaceRepo.getById(activeWorkspaceId);
      if (!workspace) { setStatus('Active workspace missing in DB'); return; }
      const allPages       = await pageRepo.getByWorkspace(activeWorkspaceId, true);
      const allGraphs      = await graphRepo.getByWorkspace(activeWorkspaceId);
      const allNodes       = (await Promise.all(allGraphs.map((g) => graphNodeRepo.getByGraph(g.id)))).flat();
      const allEdges       = (await Promise.all(allGraphs.map((g) => graphEdgeRepo.getByGraph(g.id)))).flat();
      const allChains      = await attackChainRepo.getByWorkspace(activeWorkspaceId);
      const allChangeLogs  = await changeLogRepo.getByWorkspace(activeWorkspaceId, 5000);
      const allNmapScans   = await nmapScanRepo.getByWorkspace(activeWorkspaceId);
      const allNmapMachines = (await Promise.all(allNmapScans.map((s) => nmapMachineRepo.getByScan(s.id)))).flat();
      const allSnapshots   = (await Promise.all(allPages.map((p) => db.pageSnapshots.where('pageId').equals(p.id).toArray()))).flat();
      const pageYjsUpdates = collectPageYjsUpdates(allPages.map((p) => p.id));

      const blob = await exportWorkspaceZip({
        schemaVersion: 2,
        exportedAt: Date.now(),
        workspace,
        pages: allPages,
        graphs: allGraphs,
        graphNodes: allNodes,
        graphEdges: allEdges,
        attackChains: allChains,
        changeLogs: allChangeLogs,
        nmapScans: allNmapScans,
        nmapMachines: allNmapMachines,
        pageSnapshots: allSnapshots,
        pageYjsUpdates,
      });
      downloadBlob(blob, `${workspace.name}.zip`);
      setStatus(`Workspace exported (${Object.keys(pageYjsUpdates).length} page docs included)`);
    } catch (err) {
      setStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      const graph = await graphRepo.create({ workspaceId: activeWorkspaceId, name: file.name.replace('.graphml', '') });
      const now = Date.now();
      for (const node of nodes) {
        const page = await pageRepo.create({
          workspaceId: activeWorkspaceId, parentId: null, title: node.label, isGraphPage: true,
        });
        await db.graphNodes.add({ ...node, graphId: graph.id, linkedPageId: page.id, createdAt: now, updatedAt: now });
      }
      for (const edge of edges) {
        await db.graphEdges.add({ ...edge, graphId: graph.id, createdAt: now, updatedAt: now });
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
      setStatus('Reading import…');
      try {
        const data = await parseWorkspaceZip(file);

        // ID-conflict handling. Two modes:
        //   * "new"     : remap workspace ID + remap workspaceId on all
        //                 children. Child entity IDs stay the same when
        //                 possible (so internal references survive).
        //                 If a child entity ID already exists in another
        //                 workspace, we remap that child too.
        //   * "replace" : wipe the existing workspace's entities first,
        //                 then insert with original IDs.
        const idMap = new Map<string, string>();
        const remap = (id: string) => {
          const r = idMap.get(id);
          return r ?? id;
        };

        const existingWs = await workspaceRepo.getById(data.workspace.id);

        if (importMode === 'new' && existingWs) {
          // Generate a fresh workspace id
          const newWsId = uuidv4();
          idMap.set(data.workspace.id, newWsId);
        } else if (importMode === 'replace' && existingWs) {
          // Wipe existing workspace's children before re-inserting.
          const oldPages = await pageRepo.getByWorkspace(existingWs.id, true);
          for (const p of oldPages) await db.pages.delete(p.id);
          const oldGraphs = await graphRepo.getByWorkspace(existingWs.id);
          for (const g of oldGraphs) {
            const ns = await graphNodeRepo.getByGraph(g.id);
            for (const n of ns) await db.graphNodes.delete(n.id);
            const es = await graphEdgeRepo.getByGraph(g.id);
            for (const e of es) await db.graphEdges.delete(e.id);
            await db.graphs.delete(g.id);
          }
          for (const c of await attackChainRepo.getByWorkspace(existingWs.id)) await db.attackChains.delete(c.id);
          for (const s of await nmapScanRepo.getByWorkspace(existingWs.id)) {
            const ms = await nmapMachineRepo.getByScan(s.id);
            for (const m of ms) await db.nmapMachines.delete(m.id);
            await db.nmapScans.delete(s.id);
          }
          await changeLogRepo.clear(existingWs.id);
          for (const snap of await db.pageSnapshots.where('workspaceId').equals(existingWs.id).toArray()) {
            await db.pageSnapshots.delete(snap.id);
          }
        }

        const importedWsId = remap(data.workspace.id);

        await db.workspaces.add({ ...data.workspace, id: importedWsId });
        for (const p of data.pages)         await db.pages.add({ ...p, id: remap(p.id), workspaceId: importedWsId, parentId: p.parentId ? remap(p.parentId) : null });
        for (const g of data.graphs)        await db.graphs.add({ ...g, id: remap(g.id), workspaceId: importedWsId });
        for (const n of data.graphNodes)    await db.graphNodes.add({ ...n, id: remap(n.id), graphId: remap(n.graphId), linkedPageId: remap(n.linkedPageId) });
        for (const e of data.graphEdges)    await db.graphEdges.add({ ...e, id: remap(e.id), graphId: remap(e.graphId), sourceNodeId: remap(e.sourceNodeId), targetNodeId: remap(e.targetNodeId) });
        for (const c of data.attackChains)  await db.attackChains.add({ ...c, id: remap(c.id), workspaceId: importedWsId, graphId: remap(c.graphId), linkedPageId: c.linkedPageId ? remap(c.linkedPageId) : null, nodeIds: c.nodeIds.map(remap) });
        for (const cl of data.changeLogs)   await db.changeLogs.add({ ...cl, id: remap(cl.id), workspaceId: importedWsId, targetId: remap(cl.targetId) });
        for (const s of data.nmapScans)     await db.nmapScans.add({ ...s, id: remap(s.id), workspaceId: importedWsId });
        for (const m of data.nmapMachines)  await db.nmapMachines.add({ ...m, id: remap(m.id), scanId: remap(m.scanId), linkedNodeId: m.linkedNodeId ? remap(m.linkedNodeId) : undefined });
        for (const snap of data.pageSnapshots) await db.pageSnapshots.add({ ...snap, id: remap(snap.id), pageId: remap(snap.pageId), workspaceId: importedWsId });

        // Apply page Y.Doc updates AFTER the page records exist so the
        // editor's lazy provider hookup will see the seeded content.
        for (const [origPageId, b64] of Object.entries(data.pageYjsUpdates)) {
          const target = remap(origPageId);
          try { applyImportedPageYjsUpdate(target, b64); } catch { /* per-page failure shouldn't abort the whole import */ }
        }

        await loadWorkspaces();
        setActiveWorkspace(importedWsId);
        await Promise.all([
          loadPages(), loadGraphs(), loadAttackChains(), loadNmapScans(), loadChangeLogs(),
        ]);
        setStatus(
          importMode === 'replace' && existingWs
            ? 'Workspace replaced.'
            : existingWs
              ? `Imported as new workspace (id remapped from ${data.workspace.id.slice(0, 8)}… to ${importedWsId.slice(0, 8)}…)`
              : 'Workspace imported.',
        );
      } catch (err) {
        setStatus(`Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    };
    input.click();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="fixed inset-0 bg-black/50" />
      <div className="relative z-10 w-[560px] border border-[hsl(var(--border))] bg-[hsl(var(--popover))] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
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
            <Download size={14} /> Full Workspace → ZIP <span className="ml-auto text-[10px] text-[hsl(var(--muted-foreground))]">(lossless)</span>
          </button>

          <div className="border-t border-[hsl(var(--border))] pt-3">
            <h3 className="text-sm font-semibold text-[hsl(var(--muted-foreground))] mb-2">Import</h3>
            <div className="mb-2 flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                <input type="radio" name="importMode" checked={importMode === 'new'} onChange={() => setImportMode('new')} />
                Import as new (remap IDs on conflict)
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" name="importMode" checked={importMode === 'replace'} onChange={() => setImportMode('replace')} />
                Replace existing
              </label>
            </div>
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
