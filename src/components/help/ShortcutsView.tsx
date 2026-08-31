// ─────────────────────────────────────────────────────────────────────────
// Keyboard shortcuts reference (a `shortcuts` TabKind).
//
// A short, grouped cheat-sheet to get started. The rebindable editor shortcuts
// show the account's *current* binding (via resolvePrefs), so this always
// matches what the Keybinds dialog has set; the fixed gestures are listed as
// they are wired in App.tsx / the editor plugins.
// ─────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import { Keyboard } from 'lucide-react';
import { useAuthStore } from '@/auth/auth-store';
import { resolvePrefs, formatShortcut, type KeybindAction } from '@/lib/editor-prefs';

interface Row {
  keys: string;
  label: string;
}
interface Section {
  title: string;
  hint?: string;
  rows: Row[];
}

const MOD = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘' : 'Ctrl';
/** A literal chord, e.g. `chord('Shift', '↑')`. */
const chord = (...keys: string[]) => keys.join(' + ');

export function ShortcutsView() {
  const user = useAuthStore((s) => s.user);
  const kb = useMemo(() => resolvePrefs(user).keybinds, [user]);
  const bound = (a: KeybindAction) => formatShortcut(kb[a]);

  const sections: Section[] = [
    {
      title: 'Getting around',
      rows: [
        { keys: chord(MOD, 'K'), label: 'Command palette: create pages / narratives, open tools, jump anywhere' },
        { keys: bound('quickAddEvent'), label: 'Quick-add a timeline event' },
        { keys: bound('openFollowPanel'), label: 'Active users / follow a teammate' },
        { keys: chord(MOD, 'Shift', 'A'), label: 'Open the Claude assistant' },
        { keys: chord('Alt', '←  /  →'), label: 'Switch between open tabs' },
      ],
    },
    {
      title: 'Text editor',
      hint: 'Rebindable in Profile → Keybinds.',
      rows: [
        { keys: bound('bold'), label: 'Bold' },
        { keys: bound('italic'), label: 'Italic' },
        { keys: bound('strikethrough'), label: 'Strikethrough' },
        { keys: bound('inlineCode'), label: 'Inline code' },
        { keys: bound('link'), label: 'Insert / edit link (on a selection)' },
        { keys: bound('highlight'), label: 'Highlight (last colour)' },
        { keys: chord(MOD, 'Shift', '0–8'), label: 'Turn the block into text / H1–H3 / to-do / list / code' },
      ],
    },
    {
      title: 'Blocks & selection',
      hint: 'Notion-style. Copy carries the block, so a code box stays a code box when pasted elsewhere.',
      rows: [
        { keys: 'Esc', label: 'Select the current block (leave text editing)' },
        { keys: chord('↑', '/', '↓'), label: 'Move the selection between blocks' },
        { keys: chord('Shift', '↑ / ↓'), label: 'Extend the selection across blocks' },
        { keys: chord(MOD, 'Shift', '↑ / ↓'), label: 'Move the selected block(s) up / down' },
        { keys: chord(MOD, 'D'), label: 'Duplicate the selected block(s)' },
        { keys: chord(MOD, 'A'), label: 'Ladder: select text → block → all blocks' },
        { keys: 'Enter', label: 'Edit the selected block · Backspace deletes it' },
      ],
    },
    {
      title: 'Code blocks',
      rows: [
        { keys: bound('focusLanguage'), label: 'Focus the language picker: type to search, ↑/↓ to choose, Enter to set' },
        { keys: '``` + Enter', label: 'New code block (defaults to shell; type a language after the fence)' },
      ],
    },
    {
      title: 'Images',
      rows: [
        { keys: 'Drag corner', label: 'Resize a selected image' },
        { keys: 'Right-click', label: 'Blur / edit a note image, or open it in the Assets Manager' },
        { keys: bound('blurImage'), label: 'Blur / edit the selected image' },
        { keys: 'Paste / drop', label: 'Add an image (it becomes a shared, redactable asset)' },
      ],
    },
    {
      title: 'Typst report',
      rows: [
        { keys: chord(MOD, 'F'), label: 'Find & replace across the whole document' },
        { keys: 'Click preview', label: 'Jump from the rendered page to that spot in the source' },
      ],
    },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <div className="mb-1 flex items-center gap-2">
          <Keyboard size={18} className="text-[hsl(var(--primary))]" />
          <h1 className="text-xl font-bold">Keyboard shortcuts</h1>
        </div>
        <p className="mb-6 text-xs text-[hsl(var(--muted-foreground))]">
          A quick tour of the gestures worth knowing. Editor shortcuts show your current bindings; change them in Profile → Keybinds.
        </p>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {sections.map((s) => (
            <div key={s.title} className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4">
              <div className="mb-2">
                <h2 className="text-[11px] font-bold uppercase tracking-widest text-[hsl(var(--foreground))]">{s.title}</h2>
                {s.hint && <p className="mt-0.5 text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">{s.hint}</p>}
              </div>
              <div className="flex flex-col gap-1.5">
                {s.rows.map((r, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <kbd className="mt-0.5 shrink-0 whitespace-nowrap rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-1.5 py-0.5 font-mono text-[10px] text-[hsl(var(--foreground))]">
                      {r.keys}
                    </kbd>
                    <span className="text-[11px] leading-snug text-[hsl(var(--muted-foreground))]">{r.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
