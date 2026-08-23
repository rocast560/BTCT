import { useState, useRef, useEffect } from 'react';
import { X, Download, Upload } from 'lucide-react';
import { useAuthStore, type AuthUser } from '@/auth/auth-store';
import {
  resolvePrefs,
  isThemeCustomized,
  type EditorPrefs,
  type FollowPrefs,
  type FollowPrecision,
  type ThemePrefs,
} from '@/lib/editor-prefs';
import { applyCodeAccent } from '@/lib/code-theme';
import { applyHeadingColors, resolveEffectiveHeadings } from '@/lib/theme';
import { useThemeStore } from '@/stores/theme-store';
import { usePresenceRoster } from '@/realtime/presence';
import { HeadingColorPicker } from '@/components/ui/HeadingColorPicker';

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
  const [keybinds, setKeybinds] = useState(resolved.keybinds);
  const [follow, setFollow] = useState<FollowPrefs>(resolved.follow);
  const [theme, setTheme] = useState<ThemePrefs>(resolved.theme);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Admin theme policy: the workspace default heading colours, and whether
  // they are hard-locked (then the picker is shown read-only).
  const adminHeadings = useThemeStore((s) => s.headings);
  const themeLock = useThemeStore((s) => s.lock);

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

  // Live-preview the code accent and heading colours against open editors
  // while the dialog is open; revert on unmount unless the change was saved.
  const initialCodeAccent = useRef(resolved.codeAccent);
  const initialHeadings = useRef(
    resolveEffectiveHeadings({ headings: adminHeadings, lock: themeLock }, resolved.theme).headings,
  );
  const saved = useRef(false);
  useEffect(() => () => {
    if (!saved.current) {
      applyCodeAccent(initialCodeAccent.current);
      applyHeadingColors(initialHeadings.current);
    }
  }, []);
  const handleCodeAccentChange = (v: string) => {
    setCodeAccent(v);
    if (HEX_RE.test(v)) applyCodeAccent(v);
  };
  const handleThemeChange = (t: ThemePrefs) => {
    setTheme(t);
    if (!themeLock) {
      applyHeadingColors(resolveEffectiveHeadings({ headings: adminHeadings, lock: false }, t).headings);
    }
  };

  // "Config file per user": the same prefs blob the server stores, as a
  // JSON download the user can keep and re-apply on another machine.
  const exportPrefs = () => {
    const payload = {
      format: 'btct-prefs',
      version: 1,
      exportedAt: new Date().toISOString(),
      prefs: { codeAccent, keybinds, follow, theme },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `btct-prefs-${user.username}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('Settings exported.');
  };
  const importPrefs = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const raw =
        parsed && typeof parsed === 'object' && 'prefs' in (parsed as Record<string, unknown>)
          ? (parsed as { prefs: unknown }).prefs
          : parsed;
      // resolvePrefs() drops every malformed field, so a tampered file can
      // only ever produce a valid prefs object.
      const next = resolvePrefs({ prefs: raw as Partial<EditorPrefs> });
      setCodeAccent(next.codeAccent);
      applyCodeAccent(next.codeAccent);
      setKeybinds(next.keybinds);
      setFollow(next.follow);
      handleThemeChange(next.theme);
      setError(null);
      setNotice(`Loaded ${file.name}. Review, then Save to apply.`);
    } catch {
      setError('That file is not a BTCT settings export.');
    }
  };

  const dirty =
    color !== user.color ||
    codeAccent.toLowerCase() !== resolved.codeAccent.toLowerCase() ||
    JSON.stringify(keybinds) !== JSON.stringify(resolved.keybinds) ||
    JSON.stringify(follow) !== JSON.stringify(resolved.follow) ||
    JSON.stringify(theme) !== JSON.stringify(resolved.theme);

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
      await updateProfile({ color, prefs: { codeAccent, keybinds, follow, theme } });
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

          {/* Heading colours: this account's note heading colours. Previews
              live in open editors; read-only while the admin hard-lock is on. */}
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Heading Colours
            </label>
            {themeLock ? (
              <p className="mb-1.5 text-[10px] text-[hsl(var(--status-amber))]">
                Locked by your admin: the workspace heading colours apply to everyone.
              </p>
            ) : !isThemeCustomized(theme) && isThemeCustomized(adminHeadings) ? (
              <p className="mb-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">
                Showing the workspace default. Pick a colour to use your own.
              </p>
            ) : null}
            <HeadingColorPicker
              value={themeLock ? adminHeadings : theme}
              onChange={handleThemeChange}
              disabled={themeLock}
            />
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

          {notice && !error && (
            <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">
              {notice}
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-2.5 py-1.5 text-[11px] text-[hsl(var(--status-red))]">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[hsl(var(--border))] px-4 py-3">
          {/* Settings file: export the prefs blob, or load one to review and save. */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={exportPrefs}
              title="Download your settings as a JSON file"
              className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2 py-1.5 text-[11px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
            >
              <Download size={11} /> Export
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              title="Load settings from a JSON file (review, then Save)"
              className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2 py-1.5 text-[11px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
            >
              <Upload size={11} /> Import
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => { void importPrefs(e); }}
            />
          </div>
          <div className="flex gap-2">
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
