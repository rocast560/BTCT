/**
 * Wires the Zustand app store to Y.Map change events on the shared doc.
 *
 * Whenever another user (or this user from another tab) creates / updates
 * / deletes a workspace, page, graph, node, edge, change log, nmap scan,
 * nmap machine, or attack chain, the matching `load*()` action runs and
 * the UI re-renders.
 *
 * Coalesces bursts of changes via microtask debouncing so a multi-write
 * transaction (e.g. cascading delete) only triggers one reload per table.
 */
import { subscribeTable } from '@/realtime/shared-doc';
import { useAppStore } from './app-store';
import { useThemeStore, type PublicThemeSettings } from './theme-store';

let bound = false;

export function bindSharedSubscriptions(): () => void {
  if (bound) return () => undefined;
  bound = true;

  const unsubs: Array<() => void> = [];

  const debounce = (fn: () => void) => {
    let queued = false;
    return () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; fn(); });
    };
  };

  const s = () => useAppStore.getState();

  unsubs.push(subscribeTable('workspaces',   debounce(() => { void s().loadWorkspaces(); })));
  unsubs.push(subscribeTable('pages',        debounce(() => { void s().loadPages(); })));
  unsubs.push(subscribeTable('graphs',       debounce(() => { void s().loadGraphs(); })));
  unsubs.push(subscribeTable('changeLogs',   debounce(() => { void s().loadChangeLogs(); })));
  unsubs.push(subscribeTable('nmapScans',    debounce(() => { void s().loadNmapScans(); })));
  unsubs.push(subscribeTable('attackChains', debounce(() => { void s().loadAttackChains(); })));
  unsubs.push(subscribeTable('typstAssets',  debounce(() => { void s().loadTypstAssets(); })));
  unsubs.push(subscribeTable('commandLogs',  debounce(() => { void s().loadCommandLogs(); })));

  // Admin theme policy, mirrored into the doc by the server on every save
  // (LWW JSON): re-theme live. The store drops payloads older than the one
  // it already holds, so a stale IndexedDB replay can't undo a REST seed.
  unsubs.push(subscribeTable('settingsPublic', (e) => {
    if (!e.keys.has('theme')) return;
    useThemeStore.getState().applyServerTheme(e.current('theme') as PublicThemeSettings | undefined);
  }));

  // For graph nodes/edges + nmap machines we re-run the corresponding
  // detail loader if a relevant entity is currently being viewed. The
  // cheap shortcut is to re-run `loadGraphData` for every active graph
  // tab and `loadNmapMachines` for the currently-open scan.
  const reloadGraphData = debounce(() => {
    const st = s();
    const ids = new Set<string>();
    for (const tab of st.tabs) {
      if (tab.kind === 'graph') ids.add(tab.entityId);
    }
    for (const id of ids) void st.loadGraphData(id);
  });
  unsubs.push(subscribeTable('graphNodes', reloadGraphData));
  unsubs.push(subscribeTable('graphEdges', reloadGraphData));

  // Reload only the scans whose machines actually changed: the event's
  // changed keys are machine ids, and each record (or a delete's oldValue)
  // carries its scanId. Reloading every known scan here made one port
  // toggle cost O(scans) table scans and store writes.
  const pendingScanIds = new Set<string>();
  let reloadAllScans = false;
  let machinesQueued = false;
  unsubs.push(subscribeTable('nmapMachines', (e) => {
    for (const [key, change] of e.keys) {
      const rec = (e.current(key) ?? change.oldValue) as { scanId?: string } | undefined;
      if (rec?.scanId) pendingScanIds.add(rec.scanId);
      else reloadAllScans = true; // malformed record: fall back to the old sweep
    }
    if (machinesQueued) return;
    machinesQueued = true;
    queueMicrotask(() => {
      machinesQueued = false;
      const st = s();
      const targets = reloadAllScans ? st.nmapScans.map((x) => x.id) : [...pendingScanIds];
      reloadAllScans = false;
      pendingScanIds.clear();
      for (const id of targets) void st.loadNmapMachines(id);
    });
  }));

  return () => {
    bound = false;
    for (const u of unsubs) u();
  };
}
