import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores';
import type { GraphNode, GraphEdge, HostData, CredentialData, ServiceData, FindingData, PivotData, CustomTimelineEvent } from '@/types';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Server,
  Key,
  Wrench,
  Bug,
  Shuffle,
  Clock,
  Copy,
  Check,
  Plus,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { graphNodeRepo } from '@/db/graph-node-repo';
import { graphEdgeRepo } from '@/db/graph-edge-repo';
import { v4 as uuidv4 } from 'uuid';

type TypeKey = 'host' | 'service' | 'credential' | 'pivot' | 'finding';

const typeStyles: Record<TypeKey, { label: string; color: string; bg: string; border: string; Icon: typeof Server }> = {
  host: { label: 'Host', color: 'text-sky-300', bg: 'bg-sky-500/15', border: 'border-sky-500/40', Icon: Server },
  service: { label: 'Service', color: 'text-teal-300', bg: 'bg-teal-500/15', border: 'border-teal-500/40', Icon: Wrench },
  credential: { label: 'Credential', color: 'text-amber-300', bg: 'bg-amber-500/15', border: 'border-amber-500/40', Icon: Key },
  pivot: { label: 'Pivot', color: 'text-fuchsia-300', bg: 'bg-fuchsia-500/15', border: 'border-fuchsia-500/40', Icon: Shuffle },
  finding: { label: 'Finding', color: 'text-red-300', bg: 'bg-red-500/15', border: 'border-red-500/40', Icon: Bug },
};

const severityStyles: Record<string, string> = {
  critical: 'bg-purple-500/20 text-purple-300',
  high: 'bg-red-500/20 text-red-300',
  medium: 'bg-orange-500/20 text-orange-300',
  low: 'bg-[hsl(var(--status-green))]/20 text-[hsl(var(--status-green))]',
  info: 'bg-blue-500/20 text-blue-300',
};

interface TimelineEvent {
  node: GraphNode;
  graphName: string;
  graphId: string;
  details: string;
  /** Set when this is a user quick-added event (not derived from a graph node). */
  custom?: { eventId: string; addedByName: string };
}

const CUSTOM_GRAPH_ID = '__events__';

/** Build a synthetic GraphNode from a user-added timeline event so the existing
 *  grouping / rendering can treat it like any other event. */
function customEventToNode(e: CustomTimelineEvent): GraphNode {
  return {
    id: `evt-${e.id}`,
    graphId: CUSTOM_GRAPH_ID,
    type: e.kind,
    label: e.title,
    position: { x: 0, y: 0 },
    data: {} as GraphNode['data'],
    linkedPageId: '',
    discoveredAt: e.timestamp,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

const DAY_MS = 86400000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatDayHeader(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function nodeDetails(node: GraphNode): string {
  switch (node.type) {
    case 'host': {
      const d = node.data as HostData;
      const ports = d.openPorts?.length ? ` · ports ${d.openPorts.join(',')}` : '';
      return `${d.ip || '?'} · ${d.os || '?'}${ports}`;
    }
    case 'service': {
      const d = node.data as ServiceData;
      const cve = d.cves?.length ? ` · ${d.cves.join(', ')}` : '';
      return `${d.name || '?'} ${d.version || ''} (${d.port})${cve}`;
    }
    case 'credential': {
      const d = node.data as CredentialData;
      return `${d.username || '?'} · ${d.source || 'unknown source'}`;
    }
    case 'pivot': {
      const d = node.data as PivotData;
      return d.description || 'Lateral movement step';
    }
    case 'finding': {
      const d = node.data as FindingData;
      return `[${d.severity.toUpperCase()}${d.cvss ? ` ${d.cvss.toFixed(1)}` : ''}] ${d.title || ''}`;
    }
    default:
      return '';
  }
}

function buildNarrativeMarkdown(groups: { dayTs: number; events: TimelineEvent[] }[], edgesByGraph: Map<string, GraphEdge[]>, nodeById: Map<string, GraphNode>): string {
  const lines: string[] = [];
  lines.push(`# Attack Narrative – Timeline`);
  lines.push('');
  for (const g of groups) {
    lines.push(`## ${formatDayHeader(g.dayTs)}`);
    lines.push('');
    for (const ev of g.events) {
      const typeLabel = typeStyles[ev.node.type as TypeKey].label;
      lines.push(`- **${formatTime(ev.node.discoveredAt)}** (*${typeLabel}*) **${ev.node.label}** (${ev.graphName})`);
      const det = nodeDetails(ev.node);
      if (det) lines.push(`    - ${det}`);
      // incoming edges (what led to this)
      const edges = edgesByGraph.get(ev.graphId) ?? [];
      const incoming = edges.filter((e) => e.targetNodeId === ev.node.id);
      for (const edge of incoming) {
        const src = nodeById.get(edge.sourceNodeId);
        if (src) lines.push(`        - ← from **${src.label}** via *${edge.edgeType}* (${edge.label})`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function AttackTimeline() {
  const graphs = useAppStore((s) => s.graphs);
  const openTab = useAppStore((s) => s.openTab);
  const setPendingFocusNodeId = useAppStore((s) => s.setPendingFocusNodeId);
  const customEvents = useAppStore((s) => s.timelineEvents);
  const deleteTimelineEvent = useAppStore((s) => s.deleteTimelineEvent);
  const setQuickAddOpen = useAppStore((s) => s.setQuickAddOpen);
  const [allNodes, setAllNodes] = useState<GraphNode[]>([]);
  const [allEdges, setAllEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [typeFilter, setTypeFilter] = useState<Set<TypeKey>>(new Set(['host', 'service', 'credential', 'pivot', 'finding']));
  const [graphFilter, setGraphFilter] = useState<string>('all');
  const [copied, setCopied] = useState(false);

  // Reload when the SET of graphs changes, not on every `graphs` array
  // identity: a graph rename is a Y.Text field, so it produces a new array
  // per keystroke, and each one otherwise re-ran five getAllByType reads plus
  // one getByGraph per graph. Names are picked up live by the graphName memo.
  const graphIdsKey = useMemo(() => graphs.map((g) => g.id).sort().join(','), [graphs]);
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const types: TypeKey[] = ['host', 'service', 'credential', 'pivot', 'finding'];
      const lists = await Promise.all(types.map((tp) => graphNodeRepo.getAllByType(tp)));
      // Restrict to the current workspace: `graphs` in the store is already
      // scoped to the active workspace, so any node whose graphId isn't in
      // the current `graphs` list belongs to a different workspace and must
      // be excluded from the timeline.
      const graphIds = new Set(graphIdsKey ? graphIdsKey.split(',') : []);
      const nodes = lists.flat().filter((n) => graphIds.has(n.graphId));

      // fetch edges per graph (dedupe), restricted to the current workspace
      const nodeGraphIds = Array.from(new Set(nodes.map((n) => n.graphId)));
      const edgeLists = await Promise.all(nodeGraphIds.map((gid) => graphEdgeRepo.getByGraph(gid)));
      setAllNodes(nodes);
      setAllEdges(edgeLists.flat());
      setLoading(false);
    };
    void load();
  }, [graphIdsKey]);

  const graphName = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of graphs) map.set(g.id, g.name);
    return map;
  }, [graphs]);

  const nodeById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const n of allNodes) map.set(n.id, n);
    return map;
  }, [allNodes]);

  const edgesByGraph = useMemo(() => {
    const map = new Map<string, GraphEdge[]>();
    for (const e of allEdges) {
      const arr = map.get(e.graphId) ?? [];
      arr.push(e);
      map.set(e.graphId, arr);
    }
    return map;
  }, [allEdges]);

  const filtered = useMemo(() => {
    return allNodes
      .filter((n) => typeFilter.has(n.type as TypeKey))
      .filter((n) => graphFilter === 'all' || n.graphId === graphFilter)
      .sort((a, b) => a.discoveredAt - b.discoveredAt);
  }, [allNodes, typeFilter, graphFilter]);

  const grouped = useMemo(() => {
    const byDay = new Map<number, TimelineEvent[]>();
    for (const n of filtered) {
      const d = startOfDay(n.discoveredAt);
      const ev: TimelineEvent = {
        node: n,
        graphId: n.graphId,
        graphName: graphName.get(n.graphId) ?? 'Unknown',
        details: nodeDetails(n),
      };
      const arr = byDay.get(d) ?? [];
      arr.push(ev);
      byDay.set(d, arr);
    }
    // User quick-added events (not tied to a narrative). Filtered by type;
    // shown only under "All narratives" since they belong to no graph.
    if (graphFilter === 'all') {
      for (const ce of customEvents) {
        if (!typeFilter.has(ce.kind as TypeKey)) continue;
        const node = customEventToNode(ce);
        const ev: TimelineEvent = {
          node,
          graphId: node.graphId,
          graphName: 'Manual event',
          details: ce.details,
          custom: { eventId: ce.id, addedByName: ce.createdByName },
        };
        const d = startOfDay(ce.timestamp);
        const arr = byDay.get(d) ?? [];
        arr.push(ev);
        byDay.set(d, arr);
      }
    }
    const result = Array.from(byDay.entries())
      .map(([dayTs, events]) => ({ dayTs, events: events.sort((a, b) => a.node.discoveredAt - b.node.discoveredAt) }))
      .sort((a, b) => a.dayTs - b.dayTs);
    return result;
  }, [filtered, graphName, customEvents, typeFilter, graphFilter]);

  const totalDays = grouped.length;
  const totalEvents = useMemo(() => grouped.reduce((n, g) => n + g.events.length, 0), [grouped]);

  const toggleDay = (dayTs: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dayTs)) next.delete(dayTs); else next.add(dayTs);
      return next;
    });
  };

  const toggleType = (t: TypeKey) => {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  };

  const openNodePage = (n: GraphNode) => {
    openTab({ id: uuidv4(), kind: 'page', entityId: n.linkedPageId, title: n.label });
  };

  const focusNodeOnGraph = (n: GraphNode, graphId: string, graphName: string) => {
    setPendingFocusNodeId(n.id);
    openTab({ id: uuidv4(), kind: 'graph', entityId: graphId, title: graphName });
  };

  const copyMarkdown = async () => {
    const md = buildNarrativeMarkdown(grouped, edgesByGraph, nodeById);
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">
        Loading timeline…
      </div>
    );
  }

  const span = grouped.length > 0 ? Math.round((grouped[grouped.length - 1]!.dayTs - grouped[0]!.dayTs) / DAY_MS) + 1 : 0;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold">
              <Clock size={18} className="text-[hsl(var(--status-amber))]" />
              Attack Timeline
            </h1>
            <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
              Chronological, indented view of all graph nodes across every attack narrative: use this to write the narrative section of your report.
              {' · '}{totalEvents} event{totalEvents !== 1 ? 's' : ''}{totalDays > 0 ? ` · ${totalDays} day${totalDays !== 1 ? 's' : ''} (${span}d span)` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => setQuickAddOpen(true)}
              className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--primary))]/50 bg-[hsl(var(--primary))]/15 px-3 py-1.5 text-[11px] text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/25"
              title="Add a custom event (Ctrl/⌘+Shift+E)"
            >
              <Plus size={12} /> Add event
            </button>
            <button
              onClick={() => void copyMarkdown()}
              className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-1.5 text-[11px] hover:bg-[hsl(var(--accent))]"
              title="Copy timeline as Markdown outline"
            >
              {copied ? <Check size={12} className="text-[hsl(var(--status-green))]" /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy as Markdown'}
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3">
          <div className="flex items-center gap-1">
            <span className="mr-2 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Types:</span>
            {(Object.keys(typeStyles) as TypeKey[]).map((t) => {
              const s = typeStyles[t];
              const active = typeFilter.has(t);
              const Icon = s.Icon;
              return (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px]',
                    active ? `${s.bg} ${s.border} ${s.color}` : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]',
                  )}
                >
                  <Icon size={10} />
                  {s.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1">
            <span className="mr-2 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Narrative:</span>
            <select
              value={graphFilter}
              onChange={(e) => setGraphFilter(e.target.value)}
              className="rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-[11px] outline-none"
            >
              <option value="all">All narratives</option>
              {graphs.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Timeline */}
        {grouped.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-[hsl(var(--muted-foreground))]">
            <Clock size={48} className="mb-4 opacity-30" />
            <p className="text-sm">No events to show.</p>
            <p className="mt-1 text-xs">Add nodes to attack narratives or adjust the filters above.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {grouped.map(({ dayTs, events }, dayIdx) => {
              const isCollapsed = collapsed.has(dayTs);
              return (
                <div key={dayTs} className="overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
                  {/* Day header */}
                  <button
                    onClick={() => toggleDay(dayTs)}
                    className="flex w-full items-center gap-2 border-b border-[hsl(var(--border))] px-3 py-2 text-left hover:bg-[hsl(var(--accent))]"
                  >
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <span className="text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Day {dayIdx + 1}</span>
                    <span className="text-sm font-semibold">{formatDayHeader(dayTs)}</span>
                    <span className="ml-auto rounded-full bg-[hsl(var(--muted))] px-2 py-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">
                      {events.length} event{events.length !== 1 ? 's' : ''}
                    </span>
                  </button>

                  {!isCollapsed && (
                    <div className="divide-y divide-[hsl(var(--border))]">
                      {/* column headers */}
                      <div className="grid grid-cols-[70px_110px_1fr_150px_30px] gap-2 bg-[hsl(var(--muted))]/40 px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
                        <div>Time</div>
                        <div>Type</div>
                        <div>Node & Details</div>
                        <div>Narrative</div>
                        <div></div>
                      </div>
                      {events.map((ev) => {
                        const s = typeStyles[ev.node.type as TypeKey];
                        const Icon = s.Icon;
                        const fd = !ev.custom && ev.node.type === 'finding' ? (ev.node.data as FindingData) : null;
                        const edges = ev.custom ? [] : (edgesByGraph.get(ev.graphId) ?? []);
                        const incoming = edges.filter((e) => e.targetNodeId === ev.node.id);
                        return (
                          <div key={ev.node.id} className="grid grid-cols-[70px_110px_1fr_150px_30px] items-start gap-2 px-3 py-2 text-xs hover:bg-[hsl(var(--accent))]/30">
                            <div className="font-mono text-[11px] text-[hsl(var(--foreground))]">{formatTime(ev.node.discoveredAt)}</div>
                            <div>
                              <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]', s.bg, s.border, s.color)}>
                                <Icon size={10} />
                                {s.label}
                              </span>
                            </div>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold">{ev.node.label}</span>
                                {fd && (
                                  <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide', severityStyles[fd.severity])}>
                                    {fd.severity}{fd.cvss ? ` ${fd.cvss.toFixed(1)}` : ''}
                                  </span>
                                )}
                                {ev.custom && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--primary))]/15 px-2 py-0.5 text-[9px] font-semibold text-[hsl(var(--primary))]">
                                    added by {ev.custom.addedByName}
                                  </span>
                                )}
                              </div>
                              {ev.details && (ev.custom || ev.node.type !== 'finding') && (
                                <div className="mt-0.5 truncate text-[10px] text-[hsl(var(--muted-foreground))]">{ev.details}</div>
                              )}
                              {fd && fd.title && (
                                <div className="mt-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">{fd.title}</div>
                              )}
                              {incoming.length > 0 && (
                                <div className="mt-1 space-y-0.5 border-l-2 border-[hsl(var(--border))] pl-2">
                                  {incoming.map((edge) => {
                                    const src = nodeById.get(edge.sourceNodeId);
                                    if (!src) return null;
                                    return (
                                      <div key={edge.id} className="text-[10px] text-[hsl(var(--muted-foreground))]">
                                        ← from <span className="font-medium text-[hsl(var(--foreground))]">{src.label}</span>
                                        {' · '}<span className="font-mono">{edge.edgeType}</span>
                                        {edge.label && edge.label !== edge.edgeType && <> · {edge.label}</>}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                            <div className="truncate text-[10px] text-[hsl(var(--muted-foreground))]">{ev.graphName}</div>
                            {ev.custom ? (
                              <button
                                onClick={() => { const id = ev.custom!.eventId; void deleteTimelineEvent(id); }}
                                className="justify-self-end rounded-md p-1 hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--status-red))]"
                                title="Remove this event"
                              >
                                <Trash2 size={11} className="text-[hsl(var(--muted-foreground))]" />
                              </button>
                            ) : (
                              <button
                                onClick={(e) => {
                                  if (e.shiftKey) focusNodeOnGraph(ev.node, ev.graphId, ev.graphName);
                                  else openNodePage(ev.node);
                                }}
                                className="justify-self-end rounded-md p-1 hover:bg-[hsl(var(--accent))]"
                                title="Click: open node page · Shift+Click: jump to node on attack narrative"
                              >
                                <ExternalLink size={11} className="text-[hsl(var(--muted-foreground))]" />
                              </button>
                            )}
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
