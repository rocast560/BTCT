import { useEffect, useState, memo } from 'react';
import { useAppStore } from '@/stores';
import { useShallow } from 'zustand/shallow';
import type { GraphNode, HostData, CredentialData, ServiceData, FindingData, PivotData } from '@/types';
import { format } from 'date-fns';
import { Link2, Radar, ExternalLink } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { textKey } from '@/realtime/shared-doc';
import { useYTextInput } from '@/realtime/use-y-text';

export const NodeProperties = memo(function NodeProperties({ nodeId }: { nodeId: string }) {
  const updateGraphNode = useAppStore((s) => s.updateGraphNode);
  const node = useAppStore(useShallow((s) => s.graphNodes.find((n) => n.id === nodeId)));
  const nmapMachines = useAppStore((s) => s.nmapMachines);
  const nmapScans = useAppStore((s) => s.nmapScans);
  const openTab = useAppStore((s) => s.openTab);

  // Bind label to a Y.Text CRDT — concurrent typers merge cleanly.
  // Hooks must be called unconditionally so we always invoke this even
  // when `node` hasn't loaded yet; the hook will lazily seed the Y.Text
  // with `''` and pick up the real initial value on the first remote
  // sync, which is harmless.
  const [labelValue, setLabelValue, labelRef] = useYTextInput(
    textKey('node', nodeId, 'label'),
    node?.label ?? '',
  );

  if (!node) return <p className="text-sm text-[hsl(var(--muted-foreground))]">Node not found.</p>;

  const save = (updates: Partial<Omit<GraphNode, 'id' | 'graphId' | 'createdAt'>>) => {
    void updateGraphNode(nodeId, updates);
  };

  const updateDiscoveredAt = (dateStr: string) => {
    const ts = new Date(dateStr).getTime();
    if (!isNaN(ts)) save({ discoveredAt: ts });
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-[hsl(var(--muted-foreground))]">Label</label>
        <input
          ref={labelRef}
          value={labelValue}
          onChange={(e) => setLabelValue(e.target.value)}
          className="mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none"
        />
      </div>

      <div>
        <label className="text-xs text-[hsl(var(--muted-foreground))]">Type</label>
        <div className="mt-1 rounded bg-[hsl(var(--muted))] px-2 py-1 text-sm capitalize">{node.type}</div>
      </div>

      <div>
        <label className="text-xs text-[hsl(var(--muted-foreground))]">Discovered At</label>
        <input
          type="datetime-local"
          value={format(new Date(node.discoveredAt), "yyyy-MM-dd'T'HH:mm")}
          onChange={(e) => updateDiscoveredAt(e.target.value)}
          className="mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none"
        />
      </div>

      <div className="border-t border-[hsl(var(--border))] pt-3">
        <h4 className="mb-2 text-xs font-semibold uppercase text-[hsl(var(--muted-foreground))]">Data</h4>
        <NodeDataFields node={node} onSave={save} />
      </div>

      {/* Show linked nmap machine for host nodes */}
      {node.type === 'host' && (() => {
        const linkedMachine = nmapMachines.find((m) => m.linkedNodeId === node.id);
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
            <div className="flex items-center gap-2 rounded-lg border border-[hsl(var(--status-green))]/30 bg-[hsl(var(--status-green))]/10 px-2.5 py-2">
              <Link2 size={12} className="shrink-0 text-[hsl(var(--status-green))]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-[hsl(var(--status-green))]">{linkedMachine.hostname || linkedMachine.ip}</div>
                {scan && <div className="truncate text-[10px] text-[hsl(var(--muted-foreground))]"><Radar size={8} className="inline mr-0.5" />{scan.name}</div>}
              </div>
            </div>
            <button
              onClick={() => openTab({ id: uuidv4(), kind: 'nmap-machine', entityId: linkedMachine.id, title: linkedMachine.hostname || linkedMachine.ip })}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/20 transition-colors"
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
          <Field
            label="Hostname"
            value={d.hostname}
            onChange={(v) => {
              // Also sync the node's label (title) to the new hostname so the
              // graph node and properties header reflect the change.
              onSave({ label: v });
              updateData({ hostname: v });
            }}
          />
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
      const sevOptions: Array<FindingData['severity']> = ['critical', 'high', 'medium', 'low', 'info'];
      return (
        <div className="space-y-2">
          <Field label="Title" value={d.title} onChange={(v) => updateData({ title: v })} />
          <SelectField
            label="Severity"
            value={d.severity}
            options={sevOptions}
            onChange={(v) => updateData({ severity: v })}
          />
          <CvssField value={d.cvss} onChange={(v) => updateData({ cvss: v })} />
          <Field
            label="CVSS Vector"
            value={d.cvssVector ?? ''}
            onChange={(v) => updateData({ cvssVector: v })}
            placeholder="CVSS:3.1/AV:N/AC:L/..."
            mono
          />
          <div className="grid grid-cols-2 gap-2">
            <SelectField
              label="Likelihood"
              value={d.likelihood ?? 'info'}
              options={sevOptions}
              onChange={(v) => updateData({ likelihood: v })}
            />
            <SelectField
              label="Impact"
              value={d.impact ?? 'info'}
              options={sevOptions}
              onChange={(v) => updateData({ impact: v })}
            />
          </div>
          <TextAreaField
            label="Vulnerability Description"
            value={d.description ?? ''}
            onChange={(v) => updateData({ description: v })}
            rows={3}
          />
          <TextAreaField
            label="Business Impact"
            value={d.businessImpact ?? ''}
            onChange={(v) => updateData({ businessImpact: v })}
            rows={2}
          />
          <TextAreaField
            label="Exploit Steps"
            value={d.exploitSteps ?? ''}
            onChange={(v) => updateData({ exploitSteps: v })}
            rows={4}
            mono
          />
          <Field
            label="MITRE ATT&CK"
            value={d.mitreAttack ?? ''}
            onChange={(v) => updateData({ mitreAttack: v })}
            placeholder="T1078, T1190"
          />
          <Field
            label="MITRE Mitigation"
            value={d.mitreMitigation ?? ''}
            onChange={(v) => updateData({ mitreMitigation: v })}
            placeholder="M1032, M1050"
          />
          <TextAreaField
            label="Remediation"
            value={d.remediation ?? ''}
            onChange={(v) => updateData({ remediation: v })}
            rows={3}
          />
          <Field
            label="Hosts (comma-separated)"
            value={(d.hosts ?? []).join(', ')}
            onChange={(v) => updateData({ hosts: v.split(',').map((s) => s.trim()).filter(Boolean) })}
            mono
          />
          <Field
            label="Service"
            value={d.service ?? ''}
            onChange={(v) => updateData({ service: v })}
          />
          <TextAreaField
            label="References / Resources"
            value={(d.references ?? []).join('\n')}
            onChange={(v) => updateData({ references: v.split('\n').map((s) => s.trim()).filter(Boolean) })}
            rows={3}
            placeholder={'One URL or reference per line'}
            mono
          />
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

function Field({ label, value, onChange, placeholder, mono }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <div>
      <label className="text-xs text-[hsl(var(--muted-foreground))]">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none ${mono ? 'font-mono' : ''}`}
      />
    </div>
  );
}

function TextAreaField({ label, value, onChange, rows = 3, placeholder, mono }: { label: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; mono?: boolean }) {
  return (
    <div>
      <label className="text-xs text-[hsl(var(--muted-foreground))]">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        rows={rows}
        placeholder={placeholder}
        className={`mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none resize-y ${mono ? 'font-mono' : ''}`}
      />
    </div>
  );
}

function SelectField<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div>
      <label className="text-xs text-[hsl(var(--muted-foreground))]">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="mt-1 w-full rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 text-sm outline-none capitalize"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt.charAt(0).toUpperCase() + opt.slice(1)}</option>
        ))}
      </select>
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
