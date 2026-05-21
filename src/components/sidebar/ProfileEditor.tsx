import { useState } from 'react';
import { X } from 'lucide-react';
import { useAuthStore, type AuthUser } from '@/auth/auth-store';

const COLOR_PRESETS = [
  '#ef4444', '#f59e0b', '#10b981', '#3b82f6',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
  '#22d3ee', '#a855f7', '#84cc16', '#eab308',
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function ProfileEditor({ onClose }: { onClose: () => void }) {
  const user = useAuthStore((s) => s.user) as AuthUser;
  const updateProfile = useAuthStore((s) => s.updateProfile);

  const [color, setColor] = useState(user.color);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = color !== user.color;

  const handleSave = async () => {
    if (!HEX_RE.test(color)) {
      setError('color must be a #RRGGBB hex value');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateProfile({ color });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-96 overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-3">
          <span className="text-[11px] font-bold uppercase tracking-widest">Edit Profile</span>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-[hsl(var(--accent))]" title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {/* Username (read-only) */}
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Username
            </label>
            <div className="rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">
              {user.username}
            </div>
          </div>

          {/* Color */}
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Color
            </label>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  title={c}
                  className={`h-6 w-6 rounded-full border transition ${color.toLowerCase() === c.toLowerCase() ? 'border-white ring-2 ring-white/40' : 'border-[hsl(var(--border))] hover:border-white/60'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="color"
                value={HEX_RE.test(color) ? color : '#3b82f6'}
                onChange={(e) => setColor(e.target.value)}
                className="h-8 w-10 cursor-pointer rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
              />
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="#rrggbb"
                className="flex-1 rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1.5 font-mono text-xs outline-none focus:border-[hsl(var(--primary))]"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-2.5 py-1.5 text-[11px] text-[hsl(var(--status-red))]">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[hsl(var(--border))] px-4 py-3">
          <button
            onClick={onClose}
            className="border border-[hsl(var(--border))] px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="border border-[hsl(var(--primary))] bg-[hsl(var(--primary))] px-3 py-1.5 text-xs text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
