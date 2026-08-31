// ─────────────────────────────────────────────────────────────────────────
// Paste / drop an image into a note → upload it as a shared asset and insert
// an `asset_image` node (see asset-image.ts). The image then appears in the
// Assets Manager and can be blurred non-destructively.
//
// Also: the right-click menu over a note image and the "blur the selected
// image" action, both of which open the crop/blur editor on the asset.
// ─────────────────────────────────────────────────────────────────────────

import { Plugin } from '@milkdown/prose/state';
import { NodeSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { editorViewCtx } from '@milkdown/core';
import { $prose } from '@milkdown/utils';
import { useAppStore } from '@/stores';
import { getActiveMilkdownEditor } from '@/lib/active-editor';

const IMAGE_RE = /^image\//;

function imageFilesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  return Array.from(dt.files ?? []).filter((f) => IMAGE_RE.test(f.type) || /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name));
}

/**
 * Upload each image and insert an `asset_image` node. When `pos` is given (a
 * drop), the image lands there; otherwise at the current selection.
 */
async function insertImages(view: EditorView, files: File[], pos?: number): Promise<void> {
  const store = useAppStore.getState();
  const type = view.state.schema.nodes.asset_image;
  if (!type) return;
  let at = pos;
  for (const file of files) {
    try {
      const asset = await store.addTypstAsset(file, 'image', null);
      const node = type.create({ assetId: asset.id, alt: file.name });
      if (typeof at === 'number') {
        const clamped = Math.max(0, Math.min(at, view.state.doc.content.size));
        const tr = view.state.tr.insert(clamped, node);
        view.dispatch(tr.scrollIntoView());
        at = clamped + node.nodeSize;
      } else {
        // replaceSelectionWith inserts the block and leaves the selection
        // after it, so several pasted images stack in order.
        view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
      }
    } catch {
      /* one bad upload shouldn't abort the batch */
    }
  }
}

/**
 * Paste / drop of an image → upload + insert. Uses capture-phase listeners on
 * the editor DOM rather than ProseMirror's `handlePaste`/`handleDrop` props,
 * because Milkdown's clipboard plugin also registers those and, running first,
 * consumes the event before ours would see it.
 */
export const noteImagePastePlugin = $prose(() =>
  new Plugin({
    view(view) {
      const onPaste = (event: ClipboardEvent) => {
        const files = imageFilesFrom(event.clipboardData);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void insertImages(view, files);
      };
      const onDrop = (event: DragEvent) => {
        const files = imageFilesFrom(event.dataTransfer);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void insertImages(view, files, pos);
      };
      view.dom.addEventListener('paste', onPaste, true);
      view.dom.addEventListener('drop', onDrop, true);
      return {
        destroy() {
          view.dom.removeEventListener('paste', onPaste, true);
          view.dom.removeEventListener('drop', onDrop, true);
        },
      };
    },
  }),
);

/**
 * Right-click over an `asset_image` opens a small menu (rendered app-side from
 * the `imageMenu` store flag) offering "Blur / edit image". Left to bubble for
 * any other target so the browser's own menu still works elsewhere.
 */
export const noteImageContextPlugin = $prose(() =>
  new Plugin({
    props: {
      handleDOMEvents: {
        contextmenu(_view, event) {
          const el = (event.target as HTMLElement | null)?.closest?.('.asset-image');
          const assetId = el?.querySelector('img')?.getAttribute('data-asset-id')
            ?? (el instanceof HTMLElement ? el.getAttribute('data-asset-id') : null);
          const idFromImg = (event.target as HTMLElement | null)?.closest?.('img')?.getAttribute('data-asset-id');
          const id = assetId || idFromImg;
          if (!id) return false;
          event.preventDefault();
          useAppStore.getState().setImageMenu({ x: event.clientX, y: event.clientY, assetId: id });
          return true;
        },
      },
    },
  }),
);

/** All asset ids referenced by `asset_image` nodes in a document. */
function collectAssetImageIds(doc: ProseNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((n) => {
    if (n.type.name === 'asset_image' && n.attrs.assetId) ids.add(n.attrs.assetId as string);
  });
  return ids;
}

/**
 * When an `asset_image` node is removed from a note (and no other image in the
 * same note still references that asset), delete the underlying shared asset:
 * its record, its bytes on disk, and its entry in the Assets Manager. The blur
 * / crop metadata goes with it. Fires on both local and remote deletions, so
 * every client drops the asset from its store; the server delete is idempotent
 * (a second one 404s and is ignored).
 *
 * Note: this permanently removes the shared asset, so undo restores the node
 * but not the image; and if the same asset was referenced in the Typst report,
 * that reference is emptied too.
 */
export const noteImageCleanupPlugin = $prose(() =>
  new Plugin({
    appendTransaction(trs, oldState, newState) {
      if (!trs.some((t) => t.docChanged)) return null;
      const before = collectAssetImageIds(oldState.doc);
      if (before.size === 0) return null;
      const after = collectAssetImageIds(newState.doc);
      for (const id of before) {
        if (!after.has(id)) {
          queueMicrotask(() => { void useAppStore.getState().deleteTypstAsset(id).catch(() => undefined); });
        }
      }
      return null;
    },
  }),
);

/** Open the crop/blur editor for a note image's asset. */
export function openAssetImageEditor(assetId: string): void {
  useAppStore.getState().setImageMenu(null);
  useAppStore.getState().setEditingAssetId(assetId);
}

/**
 * If the active note editor has an `asset_image` selected, open its blur/crop
 * editor. Returns true when it acted (so a keybind can preventDefault).
 */
export function blurSelectedImage(): boolean {
  const editor = getActiveMilkdownEditor();
  if (!editor) return false;
  let assetId: string | null = null;
  try {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const sel = view.state.selection;
      if (sel instanceof NodeSelection && sel.node.type.name === 'asset_image') {
        assetId = sel.node.attrs.assetId as string;
      }
    });
  } catch {
    return false;
  }
  if (!assetId) return false;
  openAssetImageEditor(assetId);
  return true;
}
