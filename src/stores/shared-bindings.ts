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

  unsubs.push(subscribeTable('nmapMachines', debounce(() => {
    const st = s();
    const open = new Set<string>();
    for (const tab of st.tabs) {
      if (tab.kind === 'nmap' || tab.kind === 'nmap-machine') open.add(tab.entityId);
    }
    // loadNmapMachines takes a scanId. For nmap-machine tabs we don't
    // know the scan, so just reload all currently-known scans.
    for (const scan of st.nmapScans) void st.loadNmapMachines(scan.id);
    void open;
  })));

  return () => {
    bound = false;
    for (const u of unsubs) u();
  };
}
