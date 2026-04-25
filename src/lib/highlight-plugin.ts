// ─────────────────────────────────────────────────────────────────────────
// Highlight mark plugin for Milkdown / Crepe.
//
// Adds a coloured text-highlight mark (rendered as <mark data-hl-color="…">).
// Colours are chosen from a fixed palette wired to CSS classes in index.css.
//
// NOTE: highlights are session-local. When the page's markdown is persisted
// the mark is stripped (CommonMark has no native highlight syntax). Re-opening
// the page reloads plain text. This is an intentional tradeoff to keep the
// saved content plain, portable markdown.
// ─────────────────────────────────────────────────────────────────────────

import { $mark } from '@milkdown/utils';
import { $command } from '@milkdown/utils';
import { toggleMark } from '@milkdown/prose/commands';
import type { MarkType } from '@milkdown/prose/model';

export const HIGHLIGHT_COLORS = [
  'yellow',
  'green',
  'blue',
  'pink',
  'orange',
  'purple',
  'red',
] as const;

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export const highlightMark = $mark('highlight', () => ({
  attrs: {
    color: { default: 'yellow' as HighlightColor, validate: 'string' },
  },
  inclusive: true,
  parseDOM: [
    {
      tag: 'mark[data-hl-color]',
      getAttrs: (node) => {
        const color = (node as HTMLElement).getAttribute('data-hl-color') ?? 'yellow';
        return { color };
      },
    },
  ],
  toDOM: (mark) => [
    'mark',
    { 'data-hl-color': String(mark.attrs.color ?? 'yellow') },
    0,
  ],
  // Highlights are not represented in CommonMark. The parser never produces
  // them and the serializer emits the inner text without any marker.
  parseMarkdown: {
    match: () => false,
    runner: () => {
      /* never invoked */
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'highlight',
    runner: () => {
      /* no-op: drop the mark on serialize, keep the text */
    },
  },
}));

/**
 * Toggle the highlight mark on the current selection with the given colour.
 * Pass `null` to clear any highlight on the selection.
 */
export const toggleHighlightCommand = $command<HighlightColor | null, 'ToggleHighlight'>(
  'ToggleHighlight',
  (ctx) => (color) => (state, dispatch) => {
    const type = highlightMark.type(ctx) as MarkType;
    if (color === null) {
      // Remove any highlight in the selection, regardless of colour.
      const { from, to, empty } = state.selection;
      if (empty) return false;
      if (!state.doc.rangeHasMark(from, to, type)) return false;
      if (dispatch) {
        dispatch(state.tr.removeMark(from, to, type));
      }
      return true;
    }
    return toggleMark(type, { color })(state, dispatch);
  },
);

export const highlightPlugin = [highlightMark, toggleHighlightCommand].flat();
