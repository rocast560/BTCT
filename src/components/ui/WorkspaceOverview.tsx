import { ArrowUpRight, FileText, Network, FileType2, Clock } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/stores';
import type { TabKind } from '@/types';

/** Small native-CSS landing view; no charts, polling, or extra UI libraries. */
export function WorkspaceOverview() {
  const { workspaces, activeWorkspaceId, pages, graphs, nmapScans, attackChains, openTab } = useAppStore(useShallow((s) => ({
    workspaces: s.workspaces, activeWorkspaceId: s.activeWorkspaceId,
    pages: s.pages, graphs: s.graphs, nmapScans: s.nmapScans,
    attackChains: s.attackChains, openTab: s.openTab,
  })));
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const localPages = pages.filter((p) => p.workspaceId === activeWorkspaceId);
  const recent = [...localPages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const open = (kind: TabKind, entityId: string, title: string) => openTab({ id: crypto.randomUUID(), kind, entityId, title });
  return (
    <div className="op-overview"><div className="op-overview-inner">
      <div className="op-eyebrow">BTCT / Workspace overview</div>
      <h1>{workspace?.name ?? 'Your workspace'}</h1>
      <p className="op-overview-subtitle">Connect the evidence. Document the path. Build the report.</p>
      <div className="op-metrics">
        {[
          [localPages.length, 'Pages'],
          [graphs.filter((g) => g.workspaceId === activeWorkspaceId).length, 'Narratives'],
          [nmapScans.filter((s) => s.workspaceId === activeWorkspaceId).length, 'Scan groups'],
          [attackChains.filter((c) => c.workspaceId === activeWorkspaceId).length, 'Attack chains'],
        ].map(([value, label]) => <div className="op-metric" key={label}><strong>{value}</strong><span>{label}</span></div>)}
      </div>
      <div className="op-overview-columns">
        <section>
          <h2 className="op-section-heading">Recently updated pages</h2>
          {recent.map((p) => <button className="op-recent" key={p.id} onClick={() => open('page', p.id, p.title)}>
            <FileText size={16} /><span className="truncate">{p.title || 'Untitled'}</span>
            <small>{new Date(p.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small><ArrowUpRight size={13} />
          </button>)}
          {!recent.length && <p className="py-6 text-[hsl(var(--muted-foreground))]">Create a page from the sidebar to begin documenting your work.</p>}
        </section>
        <section>
          <h2 className="op-section-heading">Workspace tools</h2>
          <div className="op-actions">
            <button className="op-action" onClick={() => open('findings', 'findings', 'Findings')}><Network size={18} /><span><strong>Review findings</strong><small>Prioritize evidence and impact</small></span><ArrowUpRight size={14} /></button>
            <button className="op-action" onClick={() => open('timeline', 'timeline', 'Timeline')}><Clock size={18} /><span><strong>Trace the timeline</strong><small>Follow the sequence of events</small></span><ArrowUpRight size={14} /></button>
            <button className="op-action" onClick={() => open('typst', 'typst', 'Report')}><FileType2 size={18} /><span><strong>Build the report</strong><small>Turn your notes into a deliverable</small></span><ArrowUpRight size={14} /></button>
          </div>
        </section>
      </div>
      <div className="op-footer"><span>BEEN THERE, CONQUERED THAT</span><span>Ctrl + K to find a page or command</span></div>
    </div></div>
  );
}
