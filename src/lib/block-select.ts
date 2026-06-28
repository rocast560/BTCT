// ─────────────────────────────────────────────────────────────────────────
// Notion-style block selection.
//
// Double-tap Escape while editing to leave text mode and start selecting whole
// blocks (paragraphs, headings, code blocks, lists, quotes, …). Then:
//
//   ↑ / ↓            move the single-block selection
//   Shift+↑ / ↓      extend the selection across multiple blocks
//   Backspace/Del    delete the selected block(s)
//   Enter            drop back into editing the focused block
//   Esc / click      leave block-selection mode
//   Ctrl/⌘+A         select every block
//
// Selection lives in this plugin's own state (not ProseMirror's) and is drawn
// with node decorations, so it can span several top-level blocks at once.
//
// Note: keys typed inside a code block are captured by CodeMirror (the node
// view stops events), so you enter block mode from a text block and arrow onto
// a code block to select/delete it — not from inside the code block itself.
// ─────────────────────────────────────────────────────────────────────────

import { Plugin, PluginKey, Selection } from '@milkdown/prose/state';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

interface BlockSelState {
  active: boolean;
  anchor: number; // top-level block index
  head: number;   // top-level block index
}

const KEY = new PluginKey<BlockSelState>('milkdown-block-select');
const INACTIVE: BlockSelState = { active: false, anchor: 0, head: 0 };
const DOUBLE_ESC_MS = 500;

// Module-level so the two Escape presses can be correlated across keydowns.
let lastEscAt = 0;

interface BlockInfo { from: number; to: number }

function topBlocks(doc: ProseNode): BlockInfo[] {
  const blocks: BlockInfo[] = [];
  doc.forEach((node, offset) => {
    blocks.push({ from: offset, to: offset + node.nodeSize });
  });
  return blocks;
}

function blockIndexAt(blocks: BlockInfo[], pos: number): number {
  for (let i = 0; i < blocks.length; i++) {
    if (pos >= blocks[i]!.from && pos < blocks[i]!.to) return i;
  }
  return Math.max(0, blocks.length - 1);
}

/**
 * Programmatically enter block-selection mode with the top-level block that
 * contains `pos` selected. Used to bridge a double-Esc from *inside* a code
 * block (whose CodeMirror swallows keys) into ProseMirror block selection.
 *
 * The caret is parked in an adjacent block — never inside the target — because
 * a code-block node-view pulls focus back into CodeMirror whenever the
 * selection lands inside it, which would stop arrow/Delete keys from ever
 * reaching this plugin.
 */
export function selectBlockAt(view: EditorView, pos: number): boolean {
  const blocks = topBlocks(view.state.doc);
  if (blocks.length === 0) return false;
  const idx = blockIndexAt(blocks, pos);
  const block = blocks[idx]!;
  const docSize = view.state.doc.content.size;
  // Prefer a caret just after the block, else just before it.
  const caret = block.to < docSize ? block.to : block.from > 0 ? block.from - 1 : block.from;
  const sel = Selection.near(view.state.doc.resolve(Math.max(0, Math.min(caret, docSize))));
  view.dispatch(view.state.tr.setSelection(sel).setMeta(KEY, { active: true, anchor: idx, head: idx }));
  view.focus();
  return true;
}

export const blockSelectPlugin = $prose(
  () =>
    new Plugin<BlockSelState>({
      key: KEY,
      state: {
        init: () => INACTIVE,
        apply(tr, prev) {
          const meta = tr.getMeta(KEY) as BlockSelState | undefined;
          if (meta) return meta;
          // Any real document change (typing, remote collab edit) drops us
          // back to normal editing.
          if (prev.active && tr.docChanged) return INACTIVE;
          return prev;
        },
      },
      props: {
        attributes(state): Record<string, string> {
          const s = KEY.getState(state);
          return s?.active ? { class: 'block-select-mode' } : {};
        },

        decorations(state) {
          const s = KEY.getState(state);
          if (!s?.active) return null;
          const blocks = topBlocks(state.doc);
          const lo = Math.min(s.anchor, s.head);
          const hi = Math.max(s.anchor, s.head);
          const decos: Decoration[] = [];
          for (let i = lo; i <= hi && i < blocks.length; i++) {
            decos.push(
              Decoration.node(blocks[i]!.from, blocks[i]!.to, { class: 'pm-block-selected' }),
            );
          }
          return DecorationSet.create(state.doc, decos);
        },

        handleDOMEvents: {
          // A mouse click returns to normal text editing.
          mousedown(view) {
            if (KEY.getState(view.state)?.active) {
              view.dispatch(view.state.tr.setMeta(KEY, INACTIVE));
            }
            return false;
          },
        },

        handleKeyDown(view, event) {
          const s = KEY.getState(view.state) ?? INACTIVE;
          const blocks = topBlocks(view.state.doc);
          if (blocks.length === 0) return false;

          // ── Not in block mode: watch for a double-Escape to enter. ──
          if (!s.active) {
            if (event.key === 'Escape') {
              const now = Date.now();
              if (now - lastEscAt <= DOUBLE_ESC_MS) {
                lastEscAt = 0;
                event.preventDefault();
                const idx = blockIndexAt(blocks, view.state.selection.from);
                const tr = view.state.tr
                  .setSelection(Selection.near(view.state.doc.resolve(view.state.selection.from)))
                  .setMeta(KEY, { active: true, anchor: idx, head: idx });
                view.dispatch(tr);
                return true;
              }
              lastEscAt = now;
            }
            return false;
          }

          // ── In block mode. ──
          const lo = Math.min(s.anchor, s.head);
          const hi = Math.max(s.anchor, s.head);

          const select = (anchor: number, head: number) =>
            view.dispatch(view.state.tr.setMeta(KEY, { active: true, anchor, head }));

          const exit = (sel?: Selection) => {
            const tr = view.state.tr.setMeta(KEY, INACTIVE);
            if (sel) tr.setSelection(sel);
            view.dispatch(tr);
            view.focus();
          };

          switch (event.key) {
            case 'Escape':
              event.preventDefault();
              exit();
              return true;

            case 'ArrowDown': {
              event.preventDefault();
              if (event.shiftKey) select(s.anchor, Math.min(s.head + 1, blocks.length - 1));
              else { const n = Math.min(hi + 1, blocks.length - 1); select(n, n); }
              return true;
            }

            case 'ArrowUp': {
              event.preventDefault();
              if (event.shiftKey) select(s.anchor, Math.max(s.head - 1, 0));
              else { const n = Math.max(lo - 1, 0); select(n, n); }
              return true;
            }

            case 'Backspace':
            case 'Delete': {
              event.preventDefault();
              const from = blocks[lo]!.from;
              const to = blocks[hi]!.to;
              const tr = view.state.tr.delete(from, to);
              tr.setMeta(KEY, INACTIVE);
              // The doc must keep at least one block.
              if (tr.doc.childCount === 0) {
                const para = view.state.schema.nodes.paragraph?.createAndFill();
                if (para) tr.insert(0, para);
              }
              const at = Math.min(from, tr.doc.content.size);
              tr.setSelection(Selection.near(tr.doc.resolve(at)));
              view.dispatch(tr.scrollIntoView());
              view.focus();
              return true;
            }

            case 'Enter': {
              event.preventDefault();
              const pos = Math.min(blocks[s.head]!.from + 1, view.state.doc.content.size);
              exit(Selection.near(view.state.doc.resolve(pos)));
              return true;
            }

            case 'a':
            case 'A':
              if (event.metaKey || event.ctrlKey) {
                event.preventDefault();
                select(0, blocks.length - 1);
                return true;
              }
              event.preventDefault();
              return true;

            default:
              // Swallow plain typing / arrows so nothing is edited while
              // selecting, but let modifier combos (copy, devtools, …) and
              // Tab pass through untouched.
              if (
                (event.key.length === 1 || event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
                !event.metaKey && !event.ctrlKey && !event.altKey
              ) {
                event.preventDefault();
                return true;
              }
              return false;
          }
        },
      },
    }),
);
