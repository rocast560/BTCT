// ─────────────────────────────────────────────────────────────────────────
// Raw-Typst code editor.
//
// A CodeMirror 6 instance bound to a shared-doc Y.Text via y-codemirror.next,
// so the Typst source is collaboratively edited character-by-character (with
// remote carets) exactly like the rest of BTCT — no last-writer-wins clobber.
// Undo/redo is handled by the Yjs UndoManager that yCollab installs.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, memo } from 'react';
import * as Y from 'yjs';
import { EditorState } from '@codemirror/state';
import {
  EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, keymap,
} from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { getSharedDoc } from '@/realtime/shared-doc';
import { useAuthStore } from '@/auth/auth-store';
import { typstLanguage, typstHighlightExtension } from '@/lib/typst-language';

// Editor chrome themed off the app's CSS variables so it matches both light
// and dark modes and the active accent.
const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'transparent',
      color: 'hsl(var(--foreground))',
      fontSize: '13px',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      lineHeight: '1.6',
      overflow: 'auto',
    },
    '.cm-content': { caretColor: 'hsl(var(--foreground))' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'hsl(var(--muted-foreground) / 0.6)',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'hsl(var(--muted) / 0.45)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'hsl(var(--muted) / 0.45)',
      color: 'hsl(var(--foreground))',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'hsl(var(--foreground))' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'hsl(var(--primary) / 0.25)',
    },

    // ── Ctrl/⌘+F search panel ──
    // CodeMirror's panel ships with light-mode defaults that are unreadable
    // against the app's dark chrome, so restyle it off the same CSS vars as
    // everything else.
    '.cm-panels': {
      backgroundColor: 'hsl(var(--card))',
      color: 'hsl(var(--foreground))',
      borderTop: '1px solid hsl(var(--border))',
    },
    '.cm-panel.cm-search': { padding: '6px 8px', fontSize: '11px' },
    '.cm-panel.cm-search label': {
      fontSize: '10px',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      color: 'hsl(var(--muted-foreground))',
    },
    '.cm-panel.cm-search input[type=text]': {
      backgroundColor: 'hsl(var(--background))',
      color: 'hsl(var(--foreground))',
      border: '1px solid hsl(var(--border))',
      borderRadius: '4px',
      padding: '2px 6px',
      fontSize: '11px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    },
    '.cm-panel.cm-search input[type=text]:focus': {
      outline: 'none',
      borderColor: 'hsl(var(--primary))',
    },
    '.cm-panel.cm-search button': {
      backgroundColor: 'transparent',
      backgroundImage: 'none',
      color: 'hsl(var(--foreground))',
      border: '1px solid hsl(var(--border))',
      borderRadius: '4px',
      padding: '2px 7px',
      margin: '0 2px',
      fontSize: '10px',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      cursor: 'pointer',
    },
    '.cm-panel.cm-search button:hover': { backgroundColor: 'hsl(var(--accent))' },
    '.cm-panel.cm-search button[name=close]': {
      border: 'none',
      fontSize: '15px',
      padding: '0 6px',
      color: 'hsl(var(--muted-foreground))',
    },
    // Match highlighting: the active match needs to beat the selection layer.
    '.cm-searchMatch': {
      backgroundColor: 'hsl(var(--status-purple) / 0.3)',
      outline: '1px solid hsl(var(--status-purple) / 0.5)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'hsl(var(--primary) / 0.55)',
    },
    '.cm-selectionMatch': { backgroundColor: 'hsl(var(--foreground) / 0.12)' },
  },
  { dark: true },
);

// ─────────────────────────────────────────────────────────────────────────
// Module-level handle on the live editor, so the assets panel can insert an
// `#image(…)` snippet at the caret without prop-drilling a ref through the
// split-pane tree. Mirrors the pattern in lib/active-editor.ts.
//
// Writes go through the CodeMirror view (not the Y.Text directly) so the
// insertion participates in the collab binding's undo history and lands
// exactly where the user's cursor is.
// ─────────────────────────────────────────────────────────────────────────
let activeView: EditorView | null = null;

/**
 * Select `[from, to)` and scroll it into view — the landing action for
 * click-to-source from the rendered preview.
 *
 * Centers the target rather than scrolling it to the top edge, so the
 * surrounding context stays visible. Returns false when no editor is mounted.
 */
export function revealTypstRange(from: number, to: number): boolean {
  const view = activeView;
  if (!view) return false;
  const max = view.state.doc.length;
  const anchor = Math.min(Math.max(from, 0), max);
  const head = Math.min(Math.max(to, 0), max);
  view.dispatch({
    selection: { anchor, head },
    effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
  });
  view.focus();
  return true;
}

/**
 * Insert `text` at the caret, replacing any selection. Returns false when no
 * Typst editor is mounted (the code pane is hidden), so callers can fall
 * back to copying the snippet instead.
 */
export function insertAtTypstCursor(text: string): boolean {
  const view = activeView;
  if (!view) return false;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

// Memoized: `ytext` is stable for the document's lifetime, so the CodeMirror
// instance never re-renders due to parent state changes (e.g. the divider
// drag updating the width, or the source mirror updating on each keystroke).
export const TypstEditor = memo(function TypstEditor({ ytext }: { ytext: Y.Text }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Share the same awareness used for the shared doc so remote carets and
    // name tags appear; advertise this user's presence for the labels.
    const awareness = getSharedDoc().provider.awareness;
    const user = useAuthStore.getState().user;
    if (user) {
      awareness.setLocalStateField('user', { name: user.username, color: user.color });
    }

    const undoManager = new Y.UndoManager(ytext);

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          EditorView.lineWrapping,
          EditorState.tabSize.of(2),
          typstLanguage(),
          typstHighlightExtension,
          editorTheme,
          // Ctrl/⌘+F find & replace, scoped to this editor. `top: false` puts
          // the panel at the bottom so it never covers the first lines of the
          // document. Also highlights other occurrences of the selection.
          search({ top: false }),
          highlightSelectionMatches(),
          // searchKeymap goes BEFORE defaultKeymap: both bind Mod-d
          // (selectNextOccurrence vs deleteCharForward on some platforms) and
          // the first matching handler wins.
          keymap.of([...yUndoManagerKeymap, ...searchKeymap, ...defaultKeymap, indentWithTab]),
          // Binds the editor doc to the Y.Text (source of truth) + remote carets.
          yCollab(ytext, awareness, { undoManager }),
        ],
      }),
    });

    activeView = view;

    return () => {
      // Only clear if we're still the active view — guards against a
      // remount ordering where the new instance registers before this
      // cleanup runs, which would otherwise null out the live editor.
      if (activeView === view) activeView = null;
      view.destroy();
      undoManager.destroy();
    };
  }, [ytext]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
});
