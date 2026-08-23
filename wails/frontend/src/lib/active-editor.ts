// ─────────────────────────────────────────────────────────────────────────
// Module-level reference to the currently focused Milkdown editor.
//
// Lets global keyboard handlers (e.g. Ctrl+K for link insertion in
// `App.tsx`) dispatch commands at the active editor without prop-drilling
// the ref through React. Set on mount in `MarkdownEditor` and cleared on
// unmount or focus loss.
// ─────────────────────────────────────────────────────────────────────────

import type { Editor } from '@milkdown/core';

let active: Editor | null = null;

export function setActiveMilkdownEditor(editor: Editor | null): void {
  active = editor;
}

export function getActiveMilkdownEditor(): Editor | null {
  return active;
}

/**
 * True if there is a non-empty selection inside any element matching the
 * Milkdown ProseMirror host. Used to decide whether the global Ctrl+K
 * binding should open the link prompt instead of the command palette.
 */
export function hasMilkdownSelection(): boolean {
  if (typeof window === 'undefined') return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const anchor = sel.anchorNode;
  const el = anchor && anchor.nodeType === Node.ELEMENT_NODE
    ? (anchor as Element)
    : anchor?.parentElement;
  if (!el) return false;
  return !!el.closest('.milkdown-host .ProseMirror');
}
