import { describe, it, expect } from 'vitest';
import { exportWorkspaceZip, parseWorkspaceZip, type WorkspaceExportData } from '@/export';

const base = (): WorkspaceExportData => ({
  schemaVersion: 2, exportedAt: 1, workspace: { id: 'w1', name: 'W' } as WorkspaceExportData['workspace'],
  pages: [], changeLogs: [], nmapScans: [], nmapMachines: [], pageSnapshots: [], pageYjsUpdates: {},
});

describe('workspace zip: report.typ', () => {
  it('round-trips the Typst source', async () => {
    const out = await parseWorkspaceZip(await exportWorkspaceZip({ ...base(), typstSource: '= Report\n#lorem(3)' }));
    expect(out.typstSource).toBe('= Report\n#lorem(3)');
  });
  it('omits the file and parses to null when there is no source', async () => {
    const out = await parseWorkspaceZip(await exportWorkspaceZip(base()));
    expect(out.typstSource ?? null).toBeNull();
  });
});
