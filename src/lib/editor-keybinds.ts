// ─────────────────────────────────────────────────────────────────────────
// Editor keybinds + code-block default language.
//
// Three pieces wired into the Crepe editor in PageEditor.tsx:
//
//   • `codeBlockShellDefault` — overrides the commonmark code-block schema so
//     the `/code` slash command defaults to the `shell` language.
//
//   • `userKeybindsPlugin` — a ProseMirror plugin whose `handleKeyDown` runs
//     *before* commonmark's own keymap, so per-account shortcut overrides win.
//     It also implements backtick-wraps-selection → inline code.
//
//   • `focusLanguageKeymap` — a CodeMirror keymap. Keys typed inside a code
//     block never reach ProseMirror (the node view sets `stopEvent`), so the
//     "focus the language picker" shortcut has to live in the CM layer.
//
// All three read the *current* keybinds from a module-level ref updated by
// `setEditorKeybinds`, so changing a shortcut takes effect live without
// rebuilding the editor (which would break the Yjs collab binding).
// ─────────────────────────────────────────────────────────────────────────

import { keymap, type EditorView as CodeMirrorView } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { commandsCtx, editorViewCtx, type CommandManager } from '@milkdown/core';
import { codeBlockSchema, inlineCodeSchema } from '@milkdown/preset-commonmark';
import { Plugin } from '@milkdown/prose/state';
import { $prose } from '@milkdown/utils';

import { toggleHighlightCommand } from '@/lib/highlight-plugin';
import { getActiveMilkdownEditor } from '@/lib/active-editor';
import { selectBlockAt } from '@/lib/block-select';
import {
  DEFAULT_KEYBINDS,
  matchShortcut,
  type KeybindAction,
} from '@/lib/editor-prefs';

// ── Live keybind registry ────────────────────────────────────────────────

let currentKeybinds: Record<KeybindAction, string> = { ...DEFAULT_KEYBINDS };

export function setEditorKeybinds(keybinds: Record<KeybindAction, string>): void {
  currentKeybinds = keybinds;
}

// ── /code defaults to shell ──────────────────────────────────────────────

export const codeBlockShellDefault = codeBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: {
      ...base.attrs,
      language: { ...(base.attrs?.language ?? {}), default: 'shell' },
    },
  };
});

// ── Inline code: don't let the mark "trap" the caret ─────────────────────
//
// Commonmark's `inlineCode` mark ships without an `inclusive` flag, so it
// defaults to ProseMirror's `inclusive: true`. That means the caret parked at
// the end of a `` `code` `` span is treated as *inside* the mark: the padded
// code background visually swallows the caret (it looks like it disappears),
// and the next character you type inherits the code styling — the highlight
// "bleeds" past the closing backtick. Flipping `inclusive` to false parks the
// caret just outside the closing boundary instead, so it stays visible and
// plain text resumes when you keep typing.
export const inlineCodeNonInclusive = inlineCodeSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    inclusive: false,
  };
});

// ── ProseMirror keybinds + backtick-wrap ─────────────────────────────────

// Actions handled at the ProseMirror layer (focusLanguage is CM-only), in
// match order.
const PM_ACTIONS: readonly KeybindAction[] = [
  'bold',
  'italic',
  'strikethrough',
  'inlineCode',
  'highlight',
  'link',
];

function runAction(action: KeybindAction, commands: CommandManager): void {
  switch (action) {
    case 'bold': commands.call('ToggleStrong'); break;
    case 'italic': commands.call('ToggleEmphasis'); break;
    case 'strikethrough': commands.call('ToggleStrikeThrough'); break;
    case 'inlineCode': commands.call('ToggleInlineCode'); break;
    case 'highlight': commands.call(toggleHighlightCommand.key, 'yellow'); break;
    case 'link': {
      const href = window.prompt('Link URL');
      if (href) commands.call('ToggleLink', { href, title: '' });
      break;
    }
    case 'focusLanguage': break; // handled in the CodeMirror layer
  }
}

export const userKeybindsPlugin = $prose((ctx) =>
  new Plugin({
    props: {
      handleKeyDown(view, event) {
        // Backtick over a non-empty selection → wrap as inline code. Empty
        // selection keeps the existing type-to-convert input rule.
        if (event.key === '`' && !view.state.selection.empty) {
          event.preventDefault();
          ctx.get(commandsCtx).call('ToggleInlineCode');
          return true;
        }

        for (const action of PM_ACTIONS) {
          const shortcut = currentKeybinds[action];
          if (shortcut && matchShortcut(event, shortcut)) {
            event.preventDefault();
            runAction(action, ctx.get(commandsCtx));
            return true;
          }
        }
        return false;
      },
    },
  }),
);

// ── CodeMirror: focus the language picker ────────────────────────────────

function openLanguagePicker(cmView: CodeMirrorView): boolean {
  const root = cmView.dom.closest('.milkdown-code-block');
  if (!root) return false;
  const btn = root.querySelector<HTMLButtonElement>('.language-button');
  if (!btn) return false;
  installLanguagePickerNav();
  // Clicking the button toggles the picker open and auto-focuses its search
  // input (see @milkdown/components language-picker). Avoid toggling it closed
  // if it's already open — focus the search box instead.
  if (btn.dataset.expanded === 'true') {
    root.querySelector<HTMLInputElement>('.search-input')?.focus();
  } else {
    btn.click();
  }
  return true;
}

// The bundled (Vue) language picker only handles Enter-to-select. We add
// roving arrow-key navigation with one document-level keydown listener,
// installed lazily the first time the picker is opened. It's a cheap no-op
// unless focus is currently inside an open `.language-picker`.
let languagePickerNavInstalled = false;
function installLanguagePickerNav(): void {
  if (languagePickerNavInstalled || typeof document === 'undefined') return;
  languagePickerNavInstalled = true;

  const focusEditor = (picker: Element) => {
    const cm = picker.closest('.milkdown-code-block')?.querySelector<HTMLElement>('.cm-content');
    // Defer so we don't race the picker's own close/focus handling.
    setTimeout(() => cm?.focus(), 0);
  };

  document.addEventListener(
    'keydown',
    (event) => {
      const active = document.activeElement as HTMLElement | null;
      const picker = active?.closest('.language-picker');
      if (!picker) return;

      const items = Array.from(
        picker.querySelectorAll<HTMLElement>('.language-list-item[data-language]'),
      );
      const idx = active ? items.indexOf(active) : -1;

      switch (event.key) {
        case 'ArrowDown': {
          if (!items.length) return;
          event.preventDefault();
          const next = idx < 0 ? items[0] : items[Math.min(idx + 1, items.length - 1)];
          next?.focus();
          next?.scrollIntoView({ block: 'nearest' });
          break;
        }
        case 'ArrowUp': {
          if (!items.length) return;
          event.preventDefault();
          if (idx <= 0) {
            picker.querySelector<HTMLInputElement>('.search-input')?.focus();
          } else {
            const prev = items[idx - 1];
            prev?.focus();
            prev?.scrollIntoView({ block: 'nearest' });
          }
          break;
        }
        case 'Enter': {
          const target = idx >= 0 ? items[idx] : items[0];
          if (!target) return;
          // Click selects AND closes the picker (the Enter handler in the Vue
          // component only selects). Stop propagation so it doesn't double-fire.
          event.preventDefault();
          event.stopPropagation();
          target.click();
          focusEditor(picker);
          break;
        }
        case 'Escape': {
          event.preventDefault();
          event.stopPropagation();
          const btn = picker
            .closest('.milkdown-code-block')
            ?.querySelector<HTMLButtonElement>('.language-button');
          if (btn?.dataset.expanded === 'true') btn.click(); // close it
          focusEditor(picker);
          break;
        }
      }
    },
    true, // capture: beat the component's own Enter/Escape handlers
  );
}

// Double-Esc inside a code block selects that block (Notion-style). Keys typed
// in a code block never reach ProseMirror's block-select plugin, so we detect
// the second Esc here and activate block selection on the enclosing block.
const CODE_DOUBLE_ESC_MS = 500;
let lastCodeEscAt = 0;

function selectEnclosingCodeBlock(cmView: CodeMirrorView): boolean {
  const editor = getActiveMilkdownEditor();
  const codeBlockEl = cmView.dom.closest('.milkdown-code-block');
  if (!editor || !codeBlockEl) return false;
  let handled = false;
  try {
    editor.action((ctx) => {
      const pmView = ctx.get(editorViewCtx);
      const pos = pmView.posAtDOM(codeBlockEl, 0);
      if (pos < 0) return;
      handled = selectBlockAt(pmView, pos);
    });
  } catch {
    return false;
  }
  return handled;
}

export const focusLanguageKeymap = Prec.highest(
  keymap.of([
    {
      any: (cmView, event) => {
        const shortcut = currentKeybinds.focusLanguage;
        if (!shortcut || !matchShortcut(event, shortcut)) return false;
        event.preventDefault();
        return openLanguagePicker(cmView);
      },
    },
    {
      key: 'Escape',
      run: (cmView) => {
        const now = Date.now();
        if (now - lastCodeEscAt <= CODE_DOUBLE_ESC_MS) {
          lastCodeEscAt = 0;
          return selectEnclosingCodeBlock(cmView);
        }
        lastCodeEscAt = now;
        // Let the first Esc fall through to CodeMirror (close autocomplete/search).
        return false;
      },
    },
  ]),
);
