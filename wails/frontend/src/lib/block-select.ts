// ─────────────────────────────────────────────────────────────────────────
// Notion-style block selection.
//
// Press Escape TWICE while editing to leave text mode and start selecting whole
// blocks (paragraphs, headings, code blocks, lists, quotes, …). Then:
//
//   ↑ / ↓            move the single-block selection
//   Shift+↑ / ↓      extend the selection across multiple blocks
//   Backspace/Del    delete the selected block(s); caret lands where they were
//   Enter            drop the caret INTO the selected block and edit it
//   Esc              leave block mode and restore the caret to where it started
//   click            leave block-selection mode
//   Ctrl/⌘+A         select every block
//
// Selection lives in this plugin's own state (not ProseMirror's) and is drawn
// with node decorations, so it can span several top-level blocks at once. The
// caret position the user started from is remembered (state `saved`) so a plain
// Escape puts the cursor back exactly where it was — while Enter instead drops
// into the block you highlighted, and Delete leaves the caret at the deletion.
//
// Entering takes a DOUBLE Escape. The earlier double-tap implementation earned a
// "press Esc three times" reputation because the first Esc had a visible side
// effect (it blurred / moved things), so people paused to look — blowing the
// timing window, which silently re-armed as a fresh "first" tap. This version
// fixes that by *consuming* the first Esc so it does nothing observable and can
// never leak to another handler: the only feedback is that block mode appears on
// the second press. The window (DOUBLE_ESC_MS) is generous, and an open Crepe
// popup (slash menu, link / latex / table tooltip) always wins the first Esc —
// there the key should dismiss the popup, so we bail and reset the tap timer.
//
// Keyboard handling runs in a *capture-phase* listener on `document`
// (`view()` below) rather than ProseMirror's `handleKeyDown`. Capture phase
// guarantees the Escape and the in-mode navigation keys are seen BEFORE any
// other ProseMirror plugin or Crepe feature (slash menu, tooltips, base keymap)
// can swallow them — which is what made the feature silently fail when those ran
// first.
//
// Listening on `document` (not the editor's own `.ProseMirror`) makes the
// feature *focus-independent*: a `.ProseMirror` listener only fires while the
// prose has DOM focus, but the editor is NOT auto-focused when a page opens,
// and focus is often on the title field or a button instead — so Esc did
// nothing until you first clicked into the text. The document listener lets the
// active, on-screen page editor enter block mode even when the caret isn't in
// the prose yet, while still refusing to hijack typing in another field/editor
// (see the `inThisEditor` gate). Keys originating inside a CodeMirror code
// block are ignored here; the code-block Esc is bridged separately via
// `selectBlockAt` (see editor-keybinds.ts).
// ─────────────────────────────────────────────────────────────────────────

import { Plugin, PluginKey, Selection, TextSelection } from '@milkdown/prose/state';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

interface BlockSelState {
  active: boolean;
  anchor: number; // top-level block index
  head: number;   // top-level block index
  /**
   * The text selection the caret sat at *before* block mode was entered, so
   * exiting with Escape can put the cursor back exactly where it was. `null`
   * when not in block mode. Doc positions stay valid while active because any
   * real doc change drops us out of the mode (see `state.apply`).
   */
  saved: { from: number; to: number } | null;
}

/** How long after the first Escape a second one still counts as a double-tap. */
const DOUBLE_ESC_MS = 600;

const KEY = new PluginKey<BlockSelState>('milkdown-block-select');
const INACTIVE: BlockSelState = { active: false, anchor: 0, head: 0, saved: null };

// The editor that should answer a *focus-independent* Escape (one fired while
// the caret isn't in any prose). Set when an editor mounts and whenever it's
// focused, so the most-recently-touched / only on-screen page editor wins —
// without this, split-pane editors would all react to one stray Esc.
let primaryView: EditorView | null = null;

/** Test-only: reset cross-keydown state so it can't leak across cases. */
export function __resetDoubleEscForTests(): void {
  primaryView = null;
}

// Crepe renders its popups (slash menu, link / latex / table tooltips) with a
// `data-show="true"` attribute while they're open. When one is open an Escape
// should dismiss IT, not grab a block — so block selection bails and lets the
// key propagate to the popup's own handler. Nothing else in the app uses
// `data-show`, so this is an unambiguous "a Crepe popup is open" signal.
function crepePopupOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector('[data-show="true"]');
}

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
 * Pure arrow-key navigation math. Given the current selection (anchor/head
 * block indices), the arrow pressed, and whether Shift is held, return the
 * next selection. Exported for unit testing.
 *
 *   • plain ↑/↓  collapse to a single block one step up/down from the current
 *     selection edge.
 *   • Shift+↑/↓  keep the anchor and move the head, extending the range.
 */
export function stepBlockSelection(
  s: { anchor: number; head: number },
  key: 'ArrowUp' | 'ArrowDown',
  shift: boolean,
  blockCount: number,
): { anchor: number; head: number } {
  const lo = Math.min(s.anchor, s.head);
  const hi = Math.max(s.anchor, s.head);
  if (key === 'ArrowDown') {
    if (shift) return { anchor: s.anchor, head: Math.min(s.head + 1, blockCount - 1) };
    const n = Math.min(hi + 1, blockCount - 1);
    return { anchor: n, head: n };
  }
  if (shift) return { anchor: s.anchor, head: Math.max(s.head - 1, 0) };
  const n = Math.max(lo - 1, 0);
  return { anchor: n, head: n };
}

/**
 * Programmatically enter block-selection mode with the top-level block that
 * contains `pos` selected. Used to bridge an Escape from *inside* a code
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
  // Remember where the caret was so an Escape exit can restore it.
  const original = view.state.selection;
  const idx = blockIndexAt(blocks, pos);
  const block = blocks[idx]!;
  const docSize = view.state.doc.content.size;
  // Prefer a caret just after the block, else just before it.
  const caret = block.to < docSize ? block.to : block.from > 0 ? block.from - 1 : block.from;
  const sel = Selection.near(view.state.doc.resolve(Math.max(0, Math.min(caret, docSize))));
  view.dispatch(
    view.state.tr.setSelection(sel).setMeta(KEY, {
      active: true,
      anchor: idx,
      head: idx,
      saved: { from: original.from, to: original.to },
    }),
  );
  view.focus();
  return true;
}

/**
 * Build the raw ProseMirror plugin. Exported (separately from the Milkdown
 * `$prose` wrapper) so it can be mounted on a bare EditorView in tests.
 */
export function createBlockSelectProsePlugin(): Plugin<BlockSelState> {
  return new Plugin<BlockSelState>({
    key: KEY,
    state: {
      init: () => INACTIVE,
      apply(tr, prev) {
        // Meta is applied as a patch over the previous state so navigation
        // (which only sets anchor/head) preserves `saved`, while a full reset
        // to INACTIVE clears it.
        const meta = tr.getMeta(KEY) as Partial<BlockSelState> | undefined;
        if (meta) return { ...prev, ...meta };
        // Any real document change (typing, remote collab edit) drops us back
        // to normal editing.
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
    },

    // Capture-phase keyboard handling — beats every bubble-phase handler.
    view(view) {
      // Claim "primary" on mount and on focus so a focus-independent Esc-Esc is
      // routed to the editor the user last touched / the only one on screen.
      const claimPrimary = () => { primaryView = view; };
      claimPrimary();
      view.dom.addEventListener('focusin', claimPrimary);

      // Timestamp of the first Escape of a potential double-tap (0 = not armed).
      let lastEscAt = 0;

      const onKeyDown = (event: KeyboardEvent) => {
        // Keystrokes inside a code block belong to CodeMirror (and the
        // code-block double-Esc path in editor-keybinds.ts).
        const target = event.target as HTMLElement | null;
        if (target?.closest?.('.cm-editor, .milkdown-code-block')) return;

        const s = KEY.getState(view.state) ?? INACTIVE;

        // Fast-path bail for the common case (typing anywhere): when idle the
        // only key that matters is Escape.
        if (!s.active && event.key !== 'Escape') return;

        // Does the event originate from inside THIS editor's prose? If so it's
        // the focused case and always ours. Otherwise this is a focus-
        // independent press: only the active, on-screen editor may claim it,
        // and never while the user is typing in another field/editor.
        const inThisEditor = !!target && view.dom.contains(target);
        if (!inThisEditor) {
          if (view !== primaryView) return;
          if (!view.dom.isConnected || view.dom.offsetParent === null) return;
          const active = document.activeElement as HTMLElement | null;
          const activeEditable =
            !!active &&
            (active.tagName === 'INPUT' ||
              active.tagName === 'TEXTAREA' ||
              active.tagName === 'SELECT' ||
              active.isContentEditable);
          if (activeEditable) return;
        }

        const blocks = topBlocks(view.state.doc);
        if (blocks.length === 0) return;

        // Consume the event so nothing else (PM, Crepe, browser) reacts.
        const consume = () => {
          event.preventDefault();
          event.stopPropagation();
        };

        // ── Not in block mode: a DOUBLE Escape enters block selection. ──
        if (!s.active) {
          if (event.key !== 'Escape') return;
          // A Crepe popup owns Escape — let it close and don't let that press
          // count toward the double-tap.
          if (crepePopupOpen()) {
            lastEscAt = 0;
            return;
          }
          // Consume every idle Escape so the first tap has no observable side
          // effect (the old "press it three times" bug) and can't leak to
          // another handler.
          consume();
          const nowMs = Date.now();
          if (nowMs - lastEscAt > DOUBLE_ESC_MS) {
            // First tap: arm and wait for the second.
            lastEscAt = nowMs;
            return;
          }
          // Second tap within the window → enter block mode. Remember the caret
          // so a later Escape can put it back exactly here.
          lastEscAt = 0;
          const original = view.state.selection;
          const idx = blockIndexAt(blocks, original.from);
          view.dispatch(
            view.state.tr
              .setSelection(Selection.near(view.state.doc.resolve(original.from)))
              .setMeta(KEY, {
                active: true,
                anchor: idx,
                head: idx,
                saved: { from: original.from, to: original.to },
              }),
          );
          // Pull DOM focus into the editor so in-mode keys keep flowing and
          // exiting drops the caret back in the prose (matters when we entered
          // while focus was on a button / nothing).
          view.focus();
          return;
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
          case 'Escape': {
            consume();
            // Restore the caret to exactly where it was before block mode. Use
            // Selection.near for a collapsed caret and TextSelection.between for
            // a range so both snap to valid positions if the doc shape shifted.
            if (s.saved) {
              const size = view.state.doc.content.size;
              const from = Math.min(s.saved.from, size);
              const to = Math.min(s.saved.to, size);
              const doc = view.state.doc;
              const sel =
                from === to
                  ? Selection.near(doc.resolve(from))
                  : TextSelection.between(doc.resolve(from), doc.resolve(to));
              exit(sel);
            } else {
              exit();
            }
            return;
          }

          case 'ArrowDown':
          case 'ArrowUp': {
            consume();
            const next = stepBlockSelection(s, event.key, event.shiftKey, blocks.length);
            select(next.anchor, next.head);
            return;
          }

          case 'Backspace':
          case 'Delete': {
            consume();
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
            return;
          }

          case 'Enter': {
            consume();
            const pos = Math.min(blocks[s.head]!.from + 1, view.state.doc.content.size);
            exit(Selection.near(view.state.doc.resolve(pos)));
            return;
          }

          case 'a':
          case 'A':
            if (event.metaKey || event.ctrlKey) {
              consume();
              select(0, blocks.length - 1);
              return;
            }
            consume();
            return;

          default:
            // Swallow plain typing / horizontal arrows so nothing is edited
            // while selecting, but let modifier combos (copy, devtools, …) and
            // Tab pass through untouched.
            if (
              (event.key.length === 1 || event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
              !event.metaKey && !event.ctrlKey && !event.altKey
            ) {
              consume();
            }
            return;
        }
      };

      document.addEventListener('keydown', onKeyDown, true);
      return {
        destroy() {
          document.removeEventListener('keydown', onKeyDown, true);
          view.dom.removeEventListener('focusin', claimPrimary);
          if (primaryView === view) primaryView = null;
        },
      };
    },
  });
}

export const blockSelectPlugin = $prose(() => createBlockSelectProsePlugin());
