import { useEffect, useState, memo, useCallback } from 'react';
import { useAppStore } from '@/stores';
import { useShallow } from 'zustand/shallow';
import type { GraphNode, HostData, CredentialData, ServiceData, FindingData, PivotData } from '@/types';
import { format } from 'date-fns';
import { Link2, Radar, ExternalLink } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

export const NodeProperties = memo(function NodeProperties({ nodeId }: { nodeId: string }) {
  const updateGraphNode = useAppStore((s) => s.updateGraphNode);
  const node = useAppStore(useShallow((s) => s.graphNodes.find((n) => n.id === nodeId)));
  const nmapMachines = useAppStore((s) => s.nmapMachines);
  const nmapScans = useAppStore((s) => s.nmapScans);
  const openTab = useAppStore((s) => s.openTab);
  const [localNode, setLocalNode] = useState<GraphNode | null>(null);

  useEffect(() => {
    if (node) setLocalNode({ ...node });
  }, [node]);

  if (!localNode) return <p className="text-sm text-[hsl(var(--muted-foreground))]">Node not found.</p>;

  const save = useCallback((updates: Partial<Omit<GraphNode, 'id' | 'graphId' | 'createdAt'>>) => {
    void updateGraphNode(nodeId, updates);
  }, [nodeId, updateGraphNode]);

  const updateLabel = (label: string) => {
    setLocalNode((prev) => prev ? { ...prev, label } : prev);
    save({ label });
  };

  const updateDiscoveredAt = (dateStr: string) => {
    const ts = new Date(dateStr).getTime();
    if (!isNaN(ts)) {
      setLocalNode((prev) => prev ? { ...prev, discoveredAt: ts } : prev);
      save({ discoveredAt: ts });
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-[hsl(var(--muted-foreground))]">Label</label>
        <input
          value={localNode.label}
          onChange={(e) => updateLabel(e.target.value)}
          className="mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none"
        />
      </div>

      <div>
        <label className="text-xs text-[hsl(var(--muted-foreground))]">Type</label>
        <div className="mt-1 rounded bg-[hsl(var(--muted))] px-2 py-1 text-sm capitalize">{localNode.type}</div>
      </div>

      <div>
        <label className="text-xs text-[hsl(var(--muted-foreground))]">Discovered At</label>
        <input
          type="datetime-local"
          value={format(new Date(localNode.discoveredAt), "yyyy-MM-dd'T'HH:mm")}
          onChange={(e) => updateDiscoveredAt(e.target.value)}
          className="mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none"
        />
      </div>

      <div className="border-t border-[hsl(var(--border))] pt-3">
        <h4 className="mb-2 text-xs font-semibold uppercase text-[hsl(var(--muted-foreground))]">Data</h4>
        <NodeDataFields node={localNode} onSave={save} />
      </div>

      {/* Show linked nmap machine for host nodes */}
      {localNode.type === 'host' && (() => {
        const linkedMachine = nmapMachines.find((m) => m.linkedNodeId === localNode.id);
        if (!linkedMachine) return (
          <div className="border-t border-[hsl(var(--border))] pt-3">
            <h4 className="mb-2 text-xs font-semibold uppercase text-[hsl(var(--muted-foreground))]">Nmap Link</h4>
            <p className="text-[10px] text-[hsl(var(--muted-foreground))]">No nmap machine connected.</p>
          </div>
        );
        const scan = nmapScans.find((s) => s.id === linkedMachine.scanId);
        return (
          <div className="border-t border-[hsl(var(--border))] pt-3">
            <h4 className="mb-2 text-xs font-semibold uppercase text-[hsl(var(--muted-foreground))]">Nmap Link</h4>
            <div className="flex items-center gap-2 rounded bg-emerald-500/10 border border-emerald-500/30 px-2 py-1.5">
              <Link2 size={12} className="shrink-0 text-emerald-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-emerald-300">{linkedMachine.hostname || linkedMachine.ip}</div>
                {scan && <div className="truncate text-[10px] text-[hsl(var(--muted-foreground))]"><Radar size={8} className="inline mr-0.5" />{scan.name}</div>}
              </div>
            </div>
            <button
              onClick={() => openTab({ id: uuidv4(), kind: 'nmap-machine', entityId: linkedMachine.id, title: linkedMachine.hostname || linkedMachine.ip })}
              className="mt-2 flex w-full items-center justify-center gap-1.5 border border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/20 transition-colors"
            >
              <ExternalLink size={10} /> Go to Nmap
            </button>
          </div>
        );
      })()}
    </div>
  );
});

function NodeDataFields({ node, onSave }: { node: GraphNode; onSave: (u: Partial<Omit<GraphNode, 'id' | 'graphId' | 'createdAt'>>) => void }) {
  // Keep a local copy of data so rapid edits across fields don't clobber each other.
  // Without this, each updateData call reads stale node.data from localNode (which only
  // round-trips through the store useEffect) and overwrites concurrent changes.
  const [localData, setLocalData] = useState<Record<string, unknown>>(node.data as unknown as Record<string, unknown>);

  useEffect(() => {
    setLocalData(node.data as unknown as Record<string, unknown>);
  }, [node.data]);

  const updateData = (patch: Record<string, unknown>) => {
    setLocalData((prev) => {
      const newData = { ...prev, ...patch };
      onSave({ data: newData as unknown as GraphNode['data'] });
      return newData;
    });
  };

  switch (node.type) {
    case 'host': {
      const d = localData as unknown as HostData;
      return (
        <div className="space-y-2">
          <Field label="Hostname" value={d.hostname} onChange={(v) => updateData({ hostname: v })} />
          <Field label="IP" value={d.ip} onChange={(v) => updateData({ ip: v })} />
          <Field label="OS" value={d.os} onChange={(v) => updateData({ os: v })} />
          <Field
            label="Open Ports (comma-separated)"
            value={d.openPorts.join(', ')}
            onChange={(v) => updateData({ openPorts: v.split(',').map((p) => parseInt(p.trim(), 10)).filter((n) => !isNaN(n)) })}
          />
        </div>
      );
    }
    case 'credential': {
      const d = localData as unknown as CredentialData;
      return (
        <div className="space-y-2">
          <Field label="Username" value={d.username} onChange={(v) => updateData({ username: v })} />
          <Field label="Secret (hash/password)" value={d.secret} onChange={(v) => updateData({ secret: v })} />
          <Field label="Source" value={d.source} onChange={(v) => updateData({ source: v })} />
        </div>
      );
    }
    case 'service': {
      const d = localData as unknown as ServiceData;
      return (
        <div className="space-y-2">
          <Field label="Service Name" value={d.name} onChange={(v) => updateData({ name: v })} />
          <Field label="Version" value={d.version} onChange={(v) => updateData({ version: v })} />
          <Field label="Port" value={String(d.port)} onChange={(v) => updateData({ port: parseInt(v, 10) || 0 })} />
          <Field label="CVEs (comma-separated)" value={d.cves.join(', ')} onChange={(v) => updateData({ cves: v.split(',').map((s) => s.trim()).filter(Boolean) })} />
        </div>
      );
    }
    case 'finding': {
      const d = localData as unknown as FindingData;
      return (
        <div className="space-y-2">
          <Field label="Title" value={d.title} onChange={(v) => updateData({ title: v })} />
          <div>
            <label className="text-xs text-[hsl(var(--muted-foreground))]">Severity</label>
            <select
              value={d.severity}
              onChange={(e) => updateData({ severity: e.target.value })}
              className="mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none"
            >
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
              <option value="info">Info</option>
            </select>
          </div>
          <CvssField value={d.cvss} onChange={(v) => updateData({ cvss: v })} />
        </div>
      );
    }
    case 'pivot': {
      const d = localData as unknown as PivotData;
      return (
        <div className="space-y-2">
          <div>
            <label className="text-xs text-[hsl(var(--muted-foreground))]">Description</label>
            <textarea
              value={d.description}
              onChange={(e) => updateData({ description: e.target.value })}
              className="mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none"
              rows={3}
            />
          </div>
        </div>
      );
    }
  }
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs text-[hsl(var(--muted-foreground))]">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none"
      />
    </div>
  );
}

function CvssField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [local, setLocal] = useState(value.toFixed(1));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setLocal(value.toFixed(1));
  }, [value, focused]);

  const commit = () => {
    setFocused(false);
    let num = parseFloat(local);
    if (isNaN(num)) num = 0.0;
    // num = Math.round(num * 10.0) / 10.0;
    num = Math.max(0, Math.min(10.0, num));
    setLocal(num.toFixed(1));
    onChange(num);
  };

  return (
    <div>
      <label className="text-xs text-[hsl(var(--muted-foreground))]">CVSS (0.0 – 10.0)</label>
      <input
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={commit}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commit(); }}
        className="mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none"
      />
    </div>
  );
}
