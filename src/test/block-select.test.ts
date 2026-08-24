import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';
import { Schema } from '@milkdown/prose/model';
import {
  stepBlockSelection,
  createBlockSelectProsePlugin,
  selectBlockAt,
  __resetDoubleEscForTests,
} from '@/lib/block-select';

// ── Pure navigation math ──────────────────────────────────────────────────

describe('stepBlockSelection', () => {
  it('plain ArrowDown moves the single selection down and clamps at the end', () => {
    expect(stepBlockSelection({ anchor: 0, head: 0 }, 'ArrowDown', false, 3)).toEqual({ anchor: 1, head: 1 });
    expect(stepBlockSelection({ anchor: 2, head: 2 }, 'ArrowDown', false, 3)).toEqual({ anchor: 2, head: 2 });
  });

  it('plain ArrowUp moves up and clamps at the start', () => {
    expect(stepBlockSelection({ anchor: 2, head: 2 }, 'ArrowUp', false, 3)).toEqual({ anchor: 1, head: 1 });
    expect(stepBlockSelection({ anchor: 0, head: 0 }, 'ArrowUp', false, 3)).toEqual({ anchor: 0, head: 0 });
  });

  it('Shift+Arrow keeps the anchor and extends the head', () => {
    expect(stepBlockSelection({ anchor: 0, head: 0 }, 'ArrowDown', true, 3)).toEqual({ anchor: 0, head: 1 });
    expect(stepBlockSelection({ anchor: 0, head: 1 }, 'ArrowDown', true, 3)).toEqual({ anchor: 0, head: 2 });
    expect(stepBlockSelection({ anchor: 2, head: 2 }, 'ArrowUp', true, 3)).toEqual({ anchor: 2, head: 1 });
  });

  it('plain Arrow collapses an extended selection to the moved edge', () => {
    // Selection spans 0..2; ArrowDown from the high edge collapses to 2 (clamped).
    expect(stepBlockSelection({ anchor: 0, head: 2 }, 'ArrowDown', false, 3)).toEqual({ anchor: 2, head: 2 });
    // ArrowUp collapses to one above the low edge.
    expect(stepBlockSelection({ anchor: 1, head: 2 }, 'ArrowUp', false, 3)).toEqual({ anchor: 0, head: 0 });
  });
});

// ── Real ProseMirror integration (jsdom) ───────────────────────────────────

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: {},
  },
});

function makeView(paragraphs: string[]): EditorView {
  const doc = schema.node(
    'doc',
    null,
    paragraphs.map((t) => schema.node('paragraph', null, t ? [schema.text(t)] : [])),
  );
  const state = EditorState.create({ doc, plugins: [createBlockSelectProsePlugin()] });
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return new EditorView(mount, { state });
}

function key(view: EditorView, k: string, opts: KeyboardEventInit = {}) {
  view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
}

function selectedClasses(view: EditorView): number {
  return view.dom.querySelectorAll('.pm-block-selected').length;
}

describe('block-select plugin (integration)', () => {
  beforeAll(() => {
    // jsdom has no layout engine, so prosemirror-view's coordinate lookups
    // (triggered by scrollIntoView after a block delete) throw. Give it fake
    // coords — irrelevant to what these tests assert.
    EditorView.prototype.coordsAtPos = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
  });
  beforeEach(() => __resetDoubleEscForTests());

  it('a double Escape enters block-selection mode and highlights one block', () => {
    const view = makeView(['one', 'two', 'three']);
    expect(view.dom.classList.contains('block-select-mode')).toBe(false);

    key(view, 'Escape'); // first tap only arms — nothing visible yet
    expect(view.dom.classList.contains('block-select-mode')).toBe(false);

    key(view, 'Escape'); // second tap enters
    expect(view.dom.classList.contains('block-select-mode')).toBe(true);
    expect(selectedClasses(view)).toBe(1);

    view.destroy();
  });

  it('Escape does NOT enter block mode while a Crepe popup is open', () => {
    const view = makeView(['one', 'two', 'three']);
    // Simulate an open slash menu / tooltip (Crepe marks these data-show="true").
    const popup = document.createElement('div');
    popup.setAttribute('data-show', 'true');
    document.body.appendChild(popup);

    key(view, 'Escape'); // should dismiss the popup, not grab a block or arm
    key(view, 'Escape'); // still popup-open: also ignored
    expect(view.dom.classList.contains('block-select-mode')).toBe(false);

    popup.remove();
    key(view, 'Escape'); // popup gone — first real tap arms
    key(view, 'Escape'); // second tap enters
    expect(view.dom.classList.contains('block-select-mode')).toBe(true);

    view.destroy();
  });

  it('Escape restores the caret to its pre-mode location', () => {
    const view = makeView(['one', 'two', 'three']);
    const pos = 7; // inside the second paragraph ("two")
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));

    key(view, 'Escape');
    key(view, 'Escape'); // enter block mode from block 1
    expect(view.dom.classList.contains('block-select-mode')).toBe(true);

    key(view, 'ArrowDown'); // move the highlight to a different block
    key(view, 'Escape'); // exit — caret should return to where it started

    expect(view.dom.classList.contains('block-select-mode')).toBe(false);
    expect(view.state.selection.from).toBe(pos);

    view.destroy();
  });

  it('ArrowDown moves the highlight; Shift+ArrowDown extends it', () => {
    const view = makeView(['one', 'two', 'three']);
    selectBlockAt(view, 1); // deterministic entry on block 0 (caret parked after)
    expect(view.dom.classList.contains('block-select-mode')).toBe(true);

    key(view, 'ArrowDown');
    expect(selectedClasses(view)).toBe(1); // still single block, moved down

    key(view, 'ArrowDown', { shiftKey: true });
    expect(selectedClasses(view)).toBe(2); // now spans two blocks

    view.destroy();
  });

  it('Delete removes the selected block(s) and exits the mode', () => {
    const view = makeView(['one', 'two', 'three']);
    expect(view.state.doc.childCount).toBe(3);

    selectBlockAt(view, 1);
    key(view, 'Delete');

    expect(view.state.doc.childCount).toBe(2);
    expect(view.dom.classList.contains('block-select-mode')).toBe(false);

    view.destroy();
  });

  it('Escape leaves block-selection mode without deleting', () => {
    const view = makeView(['one', 'two']);
    selectBlockAt(view, 1);
    expect(view.dom.classList.contains('block-select-mode')).toBe(true);

    key(view, 'Escape');
    expect(view.dom.classList.contains('block-select-mode')).toBe(false);
    expect(view.state.doc.childCount).toBe(2);

    view.destroy();
  });
});
