// ─────────────────────────────────────────────────────────────────────────
// Drag-to-resize for images in the note editor.
//
// Two pieces, both `.use()`d in PageEditor:
//
//   • `imageResizableSchema` extends commonmark's `image` node with a `width`
//     attribute (pixels). It lives in the ProseMirror doc, so it syncs through
//     Yjs and survives a reload like any other note content, and it is written
//     into the img's HTML/`data-width` on copy so a paste back in keeps the
//     size. Markdown has no width syntax, so a markdown export drops it (the
//     image is unchanged, just full-width again).
//
//   • `imageResizePlugin` draws a handle on the selected image and turns a drag
//     from its bottom-right corner into a `width` change. The width is written
//     straight to the DOM during the drag (one style mutation per move) and
//     committed to the node once, on release, so a live collaborator's cursor
//     and the Crepe image node view are never rebuilt mid-drag.
//
// Crepe renders images with its own (Vue) node view over the SAME `image`
// node, so we never replace that view: the width reaches the rendered <img>
// through a node decoration (style on the node view's element), and the CSS in
// index.css makes the inner <img> fill it.
// ─────────────────────────────────────────────────────────────────────────

import { imageAttr, imageSchema } from '@milkdown/preset-commonmark';
import { $prose } from '@milkdown/utils';
import { NodeSelection, Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';

/** Smallest and how-close-to-the-corner a grab counts, in CSS pixels. */
export const MIN_IMAGE_WIDTH = 48;
const HANDLE_HIT = 20;

/**
 * New width for an image dragged by `dx` pixels from its start width, clamped
 * between the minimum and the available column width. Pure, so the drag math
 * is unit-tested without a DOM.
 */
export function clampImageWidth(startWidth: number, dx: number, maxWidth: number): number {
  const upper = Math.max(MIN_IMAGE_WIDTH, maxWidth);
  return Math.round(Math.min(Math.max(startWidth + dx, MIN_IMAGE_WIDTH), upper));
}

// ── Schema: add a `width` attr to the image node ──────────────────────────

export const imageResizableSchema = imageSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: {
      ...base.attrs,
      // Pixel width, or null for the natural / full width.
      width: { default: null },
    },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom: HTMLElement | string) => {
          if (!(dom instanceof HTMLElement)) return false;
          const raw = dom.getAttribute('data-width') || dom.style.width || dom.getAttribute('width') || '';
          const w = Number.parseInt(raw, 10);
          return {
            src: dom.getAttribute('src') || '',
            alt: dom.getAttribute('alt') || '',
            title: dom.getAttribute('title') || dom.getAttribute('alt') || '',
            width: Number.isFinite(w) && w > 0 ? w : null,
          };
        },
      },
    ],
    toDOM: (node) => {
      const attrs = node.attrs as { width: number | null; [k: string]: unknown };
      const width = attrs.width;
      const out: Record<string, unknown> = {
        ...ctx.get(imageAttr.key)(node),
        src: attrs.src,
        alt: attrs.alt,
        title: attrs.title,
      };
      if (typeof width === 'number' && width > 0) {
        // The HTML width attribute travels to plain-HTML paste targets; the
        // data-width mirror is what our parseDOM reads back on a paste in.
        out.width = String(width);
        out['data-width'] = String(width);
        out.style = `width:${width}px;max-width:100%;height:auto;`;
      }
      return ['img', out];
    },
  };
});

// ── Plugin: the resize handle + drag ──────────────────────────────────────

const KEY = new PluginKey('image-resize');

interface Drag {
  pos: number;
  startX: number;
  startWidth: number;
  maxWidth: number;
  dom: HTMLElement;
}

/** The node view element for the image at `pos`, if it is rendered. */
function imageDom(view: EditorView, pos: number): HTMLElement | null {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom : null;
}

/** The rendered <img> inside an image node's element (or the element itself). */
function innerImg(el: HTMLElement): HTMLImageElement | null {
  if (el instanceof HTMLImageElement) return el;
  return el.querySelector('img');
}

export function createImageResizeProsePlugin(): Plugin {
  return new Plugin({
    key: KEY,
    props: {
      // Tag every image node so the CSS can find it, and paint the stored
      // width onto the node view's element (works whichever node view renders
      // the image, including Crepe's own).
      decorations(state) {
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'image') return;
          const width = (node.attrs as { width?: number | null }).width;
          const cls = width ? 'pm-image pm-img-sized' : 'pm-image';
          const attrs: Record<string, string> = { class: cls };
          if (width) attrs.style = `width:${width}px`;
          decos.push(Decoration.node(pos, pos + node.nodeSize, attrs));
        });
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
    },

    view(view) {
      let drag: Drag | null = null;

      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || drag) return;
        const sel = view.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'image') return;
        const dom = imageDom(view, sel.from);
        const img = dom && innerImg(dom);
        if (!dom || !img) return;

        // Only a grab that starts near the bottom-right corner resizes; a
        // click elsewhere on the image keeps selecting / dragging it.
        const rect = img.getBoundingClientRect();
        const nearCorner =
          event.clientX >= rect.right - HANDLE_HIT && event.clientX <= rect.right + 6 &&
          event.clientY >= rect.bottom - HANDLE_HIT && event.clientY <= rect.bottom + 6;
        if (!nearCorner) return;

        const column = (dom.parentElement?.clientWidth ?? view.dom.clientWidth) || rect.width;
        drag = {
          pos: sel.from,
          startX: event.clientX,
          startWidth: rect.width,
          maxWidth: column,
          dom,
        };
        event.preventDefault();
        event.stopPropagation();
        try { (event.target as Element).setPointerCapture?.(event.pointerId); } catch { /* ignore */ }
        document.body.style.cursor = 'nwse-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp, { once: true });
      };

      const onPointerMove = (event: PointerEvent) => {
        if (!drag) return;
        const next = clampImageWidth(drag.startWidth, event.clientX - drag.startX, drag.maxWidth);
        // Live: style the node view element directly (CSS makes the img fill
        // it). No transaction, so nothing re-renders mid-drag.
        drag.dom.style.width = `${next}px`;
        drag.dom.classList.add('pm-img-sized');
      };

      const onPointerUp = (event: PointerEvent) => {
        window.removeEventListener('pointermove', onPointerMove);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (!drag) return;
        const next = clampImageWidth(drag.startWidth, event.clientX - drag.startX, drag.maxWidth);
        const active = drag;
        drag = null;
        const node = view.state.doc.nodeAt(active.pos);
        if (!node || node.type.name !== 'image') return;
        view.dispatch(
          view.state.tr.setNodeMarkup(active.pos, undefined, { ...node.attrs, width: next }),
        );
      };

      view.dom.addEventListener('pointerdown', onPointerDown, true);
      return {
        destroy() {
          view.dom.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('pointermove', onPointerMove);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        },
      };
    },
  });
}

export const imageResizePlugin = $prose(() => createImageResizeProsePlugin());
