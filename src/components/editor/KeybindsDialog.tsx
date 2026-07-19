import { useState } from 'react';
import { X, Keyboard, RotateCcw } from 'lucide-react';
import { useAuthStore, type AuthUser } from '@/auth/auth-store';
import {
  KEYBIND_ACTIONS,
  DEFAULT_KEYBINDS,
  resolvePrefs,
  formatShortcut,
  shortcutFromEvent,
  parseShortcut,
  type KeybindAction,
} from '@/lib/editor-prefs';

// Editor keybinds are stored per account. This dialog captures new shortcuts
// and persists them through the same `/api/me/profile` endpoint that stores the
// profile color, so they follow the account across devices. Changes apply live
// (the editor reads keybinds from a module-level ref synced in App.tsx).
export function KeybindsDialog({ onClose }: { onClose: () => void }) {
  const user = useAuthStore((s) => s.user) as AuthUser;
  const updateProfile = useAuthStore((s) => s.updateProfile);

  const resolved = resolvePrefs(user);
  const [keybinds, setKeybinds] = useState<Record<KeybindAction, string>>(resolved.keybinds);
  const [capturing, setCapturing] = useState<KeybindAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = KEYBIND_ACTIONS.some(({ id }) => keybinds[id] !== resolved.keybinds[id]);

  const captureKeydown = (action: KeybindAction, e: React.KeyboardEvent) => {
    // Keep this dialog's capture from leaking to the global app shortcuts
    // (Ctrl+K command palette, arrow tab-switching, etc.).
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setCapturing(null);
      setError(null);
      return;
    }
    const shortcut = shortcutFromEvent(e.nativeEvent);
    if (!shortcut) return; // still waiting for a non-modifier key
    const parsed = parseShortcut(shortcut);
    if (!parsed || !(parsed.mod || parsed.alt)) {
      setError('Use a shortcut with Ctrl/⌘ or Alt');
      return;
    }
    setKeybinds((prev) => ({ ...prev, [action]: shortcut }));
    setCapturing(null);
    setError(null);
  };

  const handleReset = () => {
    setKeybinds({ ...DEFAULT_KEYBINDS });
    setCapturing(null);
    setError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateProfile({ prefs: { codeAccent: resolved.codeAccent, keybinds, follow: resolved.follow } });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-3">
          <div className="flex items-center gap-2">
            <Keyboard size={14} className="text-[hsl(var(--primary))]" />
            <span className="text-[11px] font-bold uppercase tracking-widest">Editor Keybinds</span>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-[hsl(var(--accent))]" title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
            Shortcuts for this account. Click a binding, then press the keys (must include Ctrl/⌘ or Alt).
          </p>

          <div className="flex flex-col gap-1.5">
            {KEYBIND_ACTIONS.map(({ id, label }) => {
              const isCapturing = capturing === id;
              return (
                <div
                  key={id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2"
                >
                  <span className="text-xs">{label}</span>
                  <button
                    type="button"
                    onClick={() => { setCapturing(id); setError(null); }}
                    onKeyDown={isCapturing ? (e) => captureKeydown(id, e) : undefined}
                    className={`min-w-[120px] rounded-md border px-2 py-1 text-center font-mono text-[11px] outline-none transition ${
                      isCapturing
                        ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]'
                        : 'border-[hsl(var(--input))] hover:border-[hsl(var(--primary))]/60'
                    }`}
                  >
                    {isCapturing ? 'Press keys…' : formatShortcut(keybinds[id])}
                  </button>
                </div>
              );
            })}
          </div>

          {error && (
            <div className="rounded-lg border border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-2.5 py-1.5 text-[11px] text-[hsl(var(--status-red))]">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[hsl(var(--border))] px-4 py-3">
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2.5 py-1.5 text-[11px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
          >
            <RotateCcw size={11} /> Defaults
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              className="rounded-md border border-[hsl(var(--primary))] bg-[hsl(var(--primary))] px-3 py-1.5 text-xs text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
