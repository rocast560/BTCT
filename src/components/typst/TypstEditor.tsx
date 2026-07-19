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
  },
  { dark: true },
);

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
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),
          // Binds the editor doc to the Y.Text (source of truth) + remote carets.
          yCollab(ytext, awareness, { undoManager }),
        ],
      }),
    });

    return () => {
      view.destroy();
      undoManager.destroy();
    };
  }, [ytext]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
});
