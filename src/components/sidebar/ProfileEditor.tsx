import { useState, useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import { useAuthStore, type AuthUser } from '@/auth/auth-store';
import { resolvePrefs, type FollowPrefs, type FollowPrecision } from '@/lib/editor-prefs';
import { applyCodeAccent } from '@/lib/code-theme';
import { usePresenceRoster } from '@/realtime/presence';

const COLOR_PRESETS = [
  '#ef4444', '#f59e0b', '#10b981', '#3b82f6',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
  '#22d3ee', '#a855f7', '#84cc16', '#eab308',
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function ProfileEditor({ onClose }: { onClose: () => void }) {
  const user = useAuthStore((s) => s.user) as AuthUser;
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const resolved = resolvePrefs(user);

  const [color, setColor] = useState(user.color);
  const [codeAccent, setCodeAccent] = useState(resolved.codeAccent);
  const [follow, setFollow] = useState<FollowPrefs>(resolved.follow);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Online teammates plus anyone with an existing precision override, so
  // saved overrides for offline users remain editable.
  const roster = usePresenceRoster();
  const followableUsers = (() => {
    const map = new Map<number, string>();
    for (const p of roster) map.set(p.user.id, p.user.name);
    for (const uid of Object.keys(follow.precisionByUserId)) {
      const n = Number(uid);
      if (!map.has(n)) map.set(n, `User ${uid}`);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  })();

  const precisionFor = (uid: number): FollowPrecision =>
    follow.precisionByUserId[String(uid)] ?? follow.defaultPrecision;

  // Live-preview the code accent against real code blocks while the dialog is
  // open; revert on unmount unless the change was saved.
  const initialCodeAccent = useRef(resolved.codeAccent);
  const saved = useRef(false);
  useEffect(() => () => {
    if (!saved.current) applyCodeAccent(initialCodeAccent.current);
  }, []);
  const handleCodeAccentChange = (v: string) => {
    setCodeAccent(v);
    if (HEX_RE.test(v)) applyCodeAccent(v);
  };

  const dirty =
    color !== user.color ||
    codeAccent.toLowerCase() !== resolved.codeAccent.toLowerCase() ||
    JSON.stringify(follow) !== JSON.stringify(resolved.follow);

  const handleSave = async () => {
    if (!HEX_RE.test(color)) {
      setError('color must be a #RRGGBB hex value');
      return;
    }
    if (!HEX_RE.test(codeAccent)) {
      setError('code accent must be a #RRGGBB hex value');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateProfile({ color, prefs: { codeAccent, keybinds: resolved.keybinds, follow } });
      saved.current = true;
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

          {/* Code accent — tints syntax highlighting in code blocks. Previews
              live against any open code blocks while this dialog is open. */}
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Code Accent
            </label>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => handleCodeAccentChange(c)}
                  title={c}
                  className={`h-6 w-6 rounded-full border transition ${codeAccent.toLowerCase() === c.toLowerCase() ? 'border-white ring-2 ring-white/40' : 'border-[hsl(var(--border))] hover:border-white/60'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="color"
                value={HEX_RE.test(codeAccent) ? codeAccent : '#f59e0b'}
                onChange={(e) => handleCodeAccentChange(e.target.value)}
                className="h-8 w-10 cursor-pointer rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
              />
              <input
                type="text"
                value={codeAccent}
                onChange={(e) => handleCodeAccentChange(e.target.value)}
                placeholder="#rrggbb"
                className="flex-1 rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1.5 font-mono text-xs outline-none focus:border-[hsl(var(--primary))]"
              />
            </div>
          </div>

          {/* Following — how precisely to mirror a teammate when you follow
              them. Applies to graphs (their node), pages (their cursor), and
              nmap (their host). */}
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Following
            </label>
            <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-[hsl(var(--muted-foreground))]">Default precision</span>
                <PrecisionToggle
                  value={follow.defaultPrecision}
                  onChange={(p) => setFollow((f) => ({ ...f, defaultPrecision: p }))}
                />
              </div>

              {followableUsers.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5 border-t border-[hsl(var(--border))] pt-2">
                  {followableUsers.map((u) => (
                    <div key={u.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-[11px]">{u.name}</span>
                      <PrecisionToggle
                        value={precisionFor(u.id)}
                        onChange={(p) =>
                          setFollow((f) => ({
                            ...f,
                            precisionByUserId: { ...f.precisionByUserId, [String(u.id)]: p },
                          }))
                        }
                      />
                    </div>
                  ))}
                </div>
              )}

              {follow.panePlacement && (
                <button
                  type="button"
                  onClick={() => setFollow((f) => ({ ...f, panePlacement: null }))}
                  className="mt-2 w-full rounded-md border border-[hsl(var(--border))] px-2 py-1 text-[10px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
                >
                  Reset pane layout choice (currently: {follow.panePlacement})
                </button>
              )}
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

/** Compact Precise / View-only segmented toggle for follow precision. */
function PrecisionToggle({
  value,
  onChange,
}: {
  value: FollowPrecision;
  onChange: (p: FollowPrecision) => void;
}) {
  const opts: ReadonlyArray<{ id: FollowPrecision; label: string }> = [
    { id: 'precise', label: 'Precise' },
    { id: 'view', label: 'View only' },
  ];
  return (
    <div className="flex overflow-hidden rounded-md border border-[hsl(var(--input))]">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`px-2 py-0.5 text-[10px] transition ${
            value === o.id
              ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
              : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
