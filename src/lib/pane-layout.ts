import { v4 as uuidv4 } from 'uuid';
import type { PaneNode, LeafPane, SplitPane, SplitDirection, DropPosition } from '@/types';

// ── Factories ──

export function createLeaf(tabIds: string[] = [], activeTabId: string | null = null): LeafPane {
  return { type: 'leaf', id: uuidv4(), tabIds, activeTabId };
}

// ── Queries ──

export function findLeaf(root: PaneNode, paneId: string): LeafPane | null {
  if (root.type === 'leaf') return root.id === paneId ? root : null;
  return findLeaf(root.children[0], paneId) ?? findLeaf(root.children[1], paneId);
}

export function findLeafContainingTab(root: PaneNode, tabId: string): LeafPane | null {
  if (root.type === 'leaf') return root.tabIds.includes(tabId) ? root : null;
  return findLeafContainingTab(root.children[0], tabId) ?? findLeafContainingTab(root.children[1], tabId);
}

export function firstLeaf(root: PaneNode): LeafPane {
  if (root.type === 'leaf') return root;
  return firstLeaf(root.children[0]);
}

export function isSplit(root: PaneNode): boolean {
  return root.type === 'split';
}

// ── Immutable updates ──

function mapLeaf(root: PaneNode, paneId: string, fn: (leaf: LeafPane) => LeafPane): PaneNode {
  if (root.type === 'leaf') return root.id === paneId ? fn(root) : root;
  return {
    ...root,
    children: [mapLeaf(root.children[0], paneId, fn), mapLeaf(root.children[1], paneId, fn)] as [PaneNode, PaneNode],
  };
}

/** Add a tab to a specific leaf pane. */
export function addTabToPane(root: PaneNode, paneId: string, tabId: string): PaneNode {
  return mapLeaf(root, paneId, (leaf) => ({
    ...leaf,
    tabIds: leaf.tabIds.includes(tabId) ? leaf.tabIds : [...leaf.tabIds, tabId],
    activeTabId: tabId,
  }));
}

/** Set the active tab in a specific leaf pane. */
export function setActiveInPane(root: PaneNode, paneId: string, tabId: string): PaneNode {
  return mapLeaf(root, paneId, (leaf) => ({ ...leaf, activeTabId: tabId }));
}

/** Remove a tab from whichever leaf contains it, adjusting the active tab. */
export function removeTab(root: PaneNode, tabId: string): PaneNode {
  if (root.type === 'leaf') {
    if (!root.tabIds.includes(tabId)) return root;
    const idx = root.tabIds.indexOf(tabId);
    const newIds = root.tabIds.filter((id) => id !== tabId);
    return {
      ...root,
      tabIds: newIds,
      activeTabId:
        root.activeTabId === tabId ? (newIds[Math.max(0, idx - 1)] ?? null) : root.activeTabId,
    };
  }
  return {
    ...root,
    children: [removeTab(root.children[0], tabId), removeTab(root.children[1], tabId)] as [PaneNode, PaneNode],
  };
}

/** Remove tabs matching a predicate from all leaves. */
export function removeTabsWhere(root: PaneNode, predicate: (tabId: string) => boolean): PaneNode {
  if (root.type === 'leaf') {
    const newIds = root.tabIds.filter((id) => !predicate(id));
    if (newIds.length === root.tabIds.length) return root;
    return {
      ...root,
      tabIds: newIds,
      activeTabId: root.activeTabId && predicate(root.activeTabId) ? (newIds[0] ?? null) : root.activeTabId,
    };
  }
  return {
    ...root,
    children: [removeTabsWhere(root.children[0], predicate), removeTabsWhere(root.children[1], predicate)] as [PaneNode, PaneNode],
  };
}

/** Collapse empty leaves: if a split has an empty-leaf child, replace the split with the other child. */
export function collapse(root: PaneNode): PaneNode {
  if (root.type === 'leaf') return root;
  const left = collapse(root.children[0]);
  const right = collapse(root.children[1]);
  const leftEmpty = left.type === 'leaf' && left.tabIds.length === 0;
  const rightEmpty = right.type === 'leaf' && right.tabIds.length === 0;
  if (leftEmpty && rightEmpty) return left;
  if (leftEmpty) return right;
  if (rightEmpty) return left;
  return { ...root, children: [left, right] as [PaneNode, PaneNode] };
}

/** Split a leaf, placing the new tab in an adjacent new leaf. */
export function splitLeaf(
  root: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  tabId: string,
  position: 'before' | 'after',
): PaneNode {
  if (root.type === 'leaf') {
    if (root.id !== targetPaneId) return root;
    const newLeaf = createLeaf([tabId], tabId);
    return {
      type: 'split',
      id: uuidv4(),
      direction,
      children: position === 'before' ? [newLeaf, root] : [root, newLeaf],
      ratio: 0.5,
    } as SplitPane;
  }
  return {
    ...root,
    children: [
      splitLeaf(root.children[0], targetPaneId, direction, tabId, position),
      splitLeaf(root.children[1], targetPaneId, direction, tabId, position),
    ] as [PaneNode, PaneNode],
  };
}

/** Update the ratio of a specific split node. */
export function updateRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  const clamped = Math.max(0.15, Math.min(0.85, ratio));
  if (root.type === 'leaf') return root;
  if (root.id === splitId) return { ...root, ratio: clamped };
  return {
    ...root,
    children: [updateRatio(root.children[0], splitId, ratio), updateRatio(root.children[1], splitId, ratio)] as [PaneNode, PaneNode],
  };
}

/** High-level: move a tab to a target pane at a drop position. */
export function moveTab(
  root: PaneNode,
  tabId: string,
  targetPaneId: string,
  position: DropPosition,
): PaneNode {
  // First remove from wherever it is
  let layout = removeTab(root, tabId);
  layout = collapse(layout);

  if (position === 'center') {
    // Add to target pane
    layout = addTabToPane(layout, targetPaneId, tabId);
  } else {
    // Split the target pane
    const directionMap: Record<string, SplitDirection> = { left: 'horizontal', right: 'horizontal', top: 'vertical', bottom: 'vertical' };
    const positionMap: Record<string, 'before' | 'after'> = { left: 'before', right: 'after', top: 'before', bottom: 'after' };
    layout = splitLeaf(layout, targetPaneId, directionMap[position]!, tabId, positionMap[position]!);
  }

  return layout;
}
