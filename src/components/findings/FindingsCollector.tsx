import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores';
import type { GraphNode, FindingData } from '@/types';
import { Bug, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { graphNodeRepo } from '@/db/graph-node-repo';
import { v4 as uuidv4 } from 'uuid';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

const severityStyles: Record<string, { border: string; badge: string; icon: string; accent: string }> = {
  critical: { border: 'border-purple-500/40', badge: 'bg-purple-500/20 text-purple-300', icon: 'text-purple-400', accent: 'text-purple-400' },
  high: { border: 'border-red-500/40', badge: 'bg-red-500/20 text-red-300', icon: 'text-red-400', accent: 'text-red-400' },
  medium: { border: 'border-orange-500/40', badge: 'bg-orange-500/20 text-orange-300', icon: 'text-orange-400', accent: 'text-orange-400' },
  low: { border: 'border-[hsl(var(--status-green))]/40', badge: 'bg-[hsl(var(--status-green))]/20 text-[hsl(var(--status-green))]', icon: 'text-[hsl(var(--status-green))]', accent: 'text-[hsl(var(--status-green))]' },
  info: { border: 'border-blue-500/40', badge: 'bg-blue-500/20 text-blue-300', icon: 'text-blue-400', accent: 'text-blue-400' },
};

interface FindingWithGraph extends GraphNode {
  graphName: string;
}

export function FindingsCollector() {
  const graphs = useAppStore((s) => s.graphs);
  const openTab = useAppStore((s) => s.openTab);
  const setPendingFocusNodeId = useAppStore((s) => s.setPendingFocusNodeId);
  const [findings, setFindings] = useState<FindingWithGraph[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadAllFindings();
  }, [graphs]);

  const loadAllFindings = async () => {
    setLoading(true);
    const allNodes = await graphNodeRepo.getAllByType('finding');
    // Restrict to the current workspace: graphs in the store are already
    // scoped to the active workspace, so any node whose graphId isn't in
    // the current `graphs` list belongs to a different workspace.
    const graphIds = new Set(graphs.map((g) => g.id));
    const scoped = allNodes.filter((n) => graphIds.has(n.graphId));
    const withGraph: FindingWithGraph[] = scoped.map((n) => ({
      ...n,
      graphName: graphs.find((g) => g.id === n.graphId)?.name ?? 'Unknown',
    }));
    // Sort by severity order, then CVSS descending
    withGraph.sort((a, b) => {
      const ad = a.data as FindingData;
      const bd = b.data as FindingData;
      const ai = SEVERITY_ORDER.indexOf(ad.severity as typeof SEVERITY_ORDER[number]);
      const bi = SEVERITY_ORDER.indexOf(bd.severity as typeof SEVERITY_ORDER[number]);
      if (ai !== bi) return ai - bi;
      return bd.cvss - ad.cvss;
    });
    setFindings(withGraph);
    setLoading(false);
  };

  const toggleSection = (sev: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev);
      else next.add(sev);
      return next;
    });
  };

  const openFindingPage = (finding: FindingWithGraph) => {
    openTab({ id: uuidv4(), kind: 'page', entityId: finding.linkedPageId, title: finding.label });
  };

  const focusFindingOnGraph = (finding: FindingWithGraph) => {
    const graph = graphs.find((g) => g.id === finding.graphId);
    if (!graph) return;
    setPendingFocusNodeId(finding.id);
    openTab({ id: uuidv4(), kind: 'graph', entityId: graph.id, title: graph.name });
  };

  // Group by severity
  const grouped = SEVERITY_ORDER.map((sev) => ({
    severity: sev,
    items: findings.filter((f) => (f.data as FindingData).severity === sev),
  })).filter((g) => g.items.length > 0);

  // Stats
  const total = findings.length;
  const countBySev = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, findings.filter((f) => (f.data as FindingData).severity === s).length]));

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">
        Loading findings…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-bold">Findings Collector</h1>
          <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
            Automatically collected from all attack narratives · {total} finding{total !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Summary bar */}
        <div className="mb-6 flex gap-3">
          {SEVERITY_ORDER.map((sev) => {
            const style = severityStyles[sev]!;
            const count = countBySev[sev] ?? 0;
            return (
              <div key={sev} className={cn('flex-1 rounded-xl border bg-[hsl(var(--card))] p-3', style.border)}>
                <div className={cn('text-[10px] font-bold uppercase tracking-widest', style.accent)}>{sev}</div>
                <div className="mt-1 text-2xl font-bold">{count}</div>
              </div>
            );
          })}
        </div>

        {/* Findings grouped by severity */}
        {findings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-[hsl(var(--muted-foreground))]">
            <Bug size={48} className="mb-4 text-[hsl(var(--status-red))] opacity-30" />
            <p className="text-sm">No findings yet.</p>
            <p className="mt-1 text-xs">Add finding nodes to your attack narratives to see them here.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {grouped.map(({ severity, items }) => {
              const style = severityStyles[severity]!;
              const collapsed = collapsedSections.has(severity);
              return (
                <div key={severity} className={cn('overflow-hidden rounded-xl border bg-[hsl(var(--card))]', style.border)}>
                  <button
                    onClick={() => toggleSection(severity)}
                    className="flex w-full items-center gap-3 px-4 py-3 hover:bg-[hsl(var(--accent))]"
                  >
                    {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <span className={cn('text-[10px] font-bold uppercase tracking-widest', style.accent)}>{severity}</span>
                    <span className={cn('rounded-full px-2 py-0.5 text-[9px]', style.badge)}>{items.length}</span>
                  </button>
                  {!collapsed && (
                    <div className="divide-y divide-[hsl(var(--border))]">
                      {items.map((finding) => {
                        const fd = finding.data as FindingData;
                        return (
                          <div key={finding.id} className="flex items-center gap-4 px-4 py-2.5">
                            <Bug size={14} className={style.icon} />
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-semibold">{finding.label}</div>
                              {fd.title && <div className="text-[10px] text-[hsl(var(--muted-foreground))]">{fd.title}</div>}
                              <div className="mt-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">
                                {finding.graphName}
                              </div>
                            </div>
                            {fd.cvss > 0 && (
                              <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-mono', style.badge)}>
                                {fd.cvss.toFixed(1)}
                              </span>
                            )}
                            <button
                              onClick={(e) => {
                                if (e.shiftKey) focusFindingOnGraph(finding);
                                else openFindingPage(finding);
                              }}
                              className="shrink-0 p-1 hover:bg-[hsl(var(--accent))]"
                              title="Click: open finding page · Shift+Click: jump to node on attack narrative"
                            >
                              <ExternalLink size={12} className="text-[hsl(var(--muted-foreground))]" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
