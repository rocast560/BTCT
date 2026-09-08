// ─────────────────────────────────────────────────────────────────────────
// Asset-backed images in the note editor.
//
// An `asset_image` node references a shared image asset by id instead of
// embedding bytes. That means an image pasted into a note (see
// `note-image-paste.ts`, which uploads it and inserts this node) shows up in
// the Assets Manager, and can be cropped / blurred with the same
// non-destructive editor the report uses: the crop and blur are metadata on
// the asset, so the original is never overwritten and a blur can always be
// removed again.
//
// The node view renders the asset's *resolved* bytes (crop + blur applied) and
// subscribes to the store, so committing a blur in the editor updates the note
// image live. It carries the same `pm-image` class as the other images, so the
// drag-to-resize plugin (image-resize.ts, which includes `asset_image` in its
// node set) handles the width handle for free.
// ─────────────────────────────────────────────────────────────────────────

import { $node, $view } from '@milkdown/utils';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { useAppStore } from '@/stores';
import { blursKey } from '@/lib/blur-math';
import { resolveAssetBytes } from '@/lib/assets';
import type { TypstAsset } from '@/types';

const ASSET_URL_PREFIX = 'asset:';

export const assetImageSchema = $node('asset_image', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  isolating: true,
  marks: '',
  attrs: {
    assetId: { default: '' },
    alt: { default: '' },
    width: { default: null },
  },
  parseDOM: [
    {
      tag: 'img[data-asset-id]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        const w = Number.parseInt(dom.getAttribute('data-width') || dom.getAttribute('width') || '', 10);
        return {
          assetId: dom.getAttribute('data-asset-id') || '',
          alt: dom.getAttribute('alt') || '',
          width: Number.isFinite(w) && w > 0 ? w : null,
        };
      },
    },
  ],
  toDOM: (node) => {
    const { assetId, alt, width } = node.attrs as { assetId: string; alt: string; width: number | null };
    const attrs: Record<string, string> = {
      'data-asset-id': assetId,
      src: `${ASSET_URL_PREFIX}${assetId}`,
      alt,
    };
    if (typeof width === 'number' && width > 0) {
      attrs.width = String(width);
      attrs['data-width'] = String(width);
      attrs.style = `width:${width}px;max-width:100%;height:auto;`;
    }
    return ['img', attrs];
  },
  parseMarkdown: {
    match: (node) => node.type === 'image' && typeof node.url === 'string' && node.url.startsWith(ASSET_URL_PREFIX),
    runner: (state, node, type) => {
      state.addNode(type, {
        assetId: String(node.url).slice(ASSET_URL_PREFIX.length),
        alt: typeof node.alt === 'string' ? node.alt : '',
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'asset_image',
    runner: (state, node) => {
      state.addNode('image', undefined, undefined, {
        url: `${ASSET_URL_PREFIX}${node.attrs.assetId}`,
        alt: node.attrs.alt,
        title: '',
      });
    },
  },
}));

/** Cache key for the resolved bytes: re-render only when framing changes. */
function frameKey(asset: TypstAsset): string {
  const c = asset.crop ? `${asset.crop.x},${asset.crop.y},${asset.crop.w},${asset.crop.h}` : '';
  return `${asset.id}|${c}|${blursKey(asset.blurs)}`;
}

export const assetImageView = $view(assetImageSchema, () => {
  return (initialNode: ProseNode) => {
    const dom = document.createElement('div');
    dom.className = 'pm-image asset-image';
    const img = document.createElement('img');
    img.alt = initialNode.attrs.alt || '';
    // Expose the asset id on the DOM so the right-click menu (note-image-paste)
    // can find it without the ProseMirror selection.
    img.dataset.assetId = initialNode.attrs.assetId || '';
    dom.dataset.assetId = initialNode.attrs.assetId || '';
    dom.appendChild(img);

    let node = initialNode;
    let renderedKey = '';
    let objUrl: string | null = null;

    const applyWidth = () => {
      const w = node.attrs.width as number | null;
      if (typeof w === 'number' && w > 0) {
        dom.style.width = `${w}px`;
        dom.classList.add('pm-img-sized');
      } else {
        dom.style.width = '';
        dom.classList.remove('pm-img-sized');
      }
    };

    const render = () => {
      applyWidth();
      img.dataset.assetId = node.attrs.assetId || '';
      dom.dataset.assetId = node.attrs.assetId || '';
      const asset = useAppStore.getState().typstAssets.find((a) => a.id === node.attrs.assetId);
      if (!asset) {
        img.removeAttribute('src');
        img.alt = 'image not found in assets';
        renderedKey = '';
        return;
      }
      const key = frameKey(asset);
      if (key === renderedKey) return;
      renderedKey = key;
      // Resolved bytes = original with crop + blur applied (non-destructive).
      void resolveAssetBytes(asset)
        .then((bytes) => {
          if (node.attrs.assetId !== asset.id) return; // node changed underneath us
          const next = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/png' }));
          if (objUrl) URL.revokeObjectURL(objUrl);
          objUrl = next;
          img.src = next;
          img.alt = asset.filename;
        })
        .catch(() => { renderedKey = ''; });
    };

    render();
    // Re-render when the asset's crop/blur (or the asset list) changes.
    const unsubscribe = useAppStore.subscribe(() => render());

    return {
      dom,
      update: (updated: ProseNode) => {
        if (updated.type !== initialNode.type) return false;
        node = updated;
        render();
        return true;
      },
      selectNode: () => dom.classList.add('ProseMirror-selectednode'),
      deselectNode: () => dom.classList.remove('ProseMirror-selectednode'),
      stopEvent: () => false,
      ignoreMutation: () => true,
      destroy: () => {
        unsubscribe();
        if (objUrl) URL.revokeObjectURL(objUrl);
      },
    };
  };
});
