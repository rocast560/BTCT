import { useState, useRef, useEffect } from 'react';
import { X, Palette, RotateCcw, Lock } from 'lucide-react';
import { useThemeStore } from '@/stores/theme-store';
import { useAuthStore } from '@/auth/auth-store';
import { applyHeadingColors, DEFAULT_THEME_COLOR, resolveEffectiveHeadings } from '@/lib/theme';
import { resolvePrefs, type ThemePrefs } from '@/lib/editor-prefs';
import { HeadingColorPicker } from '@/components/ui/HeadingColorPicker';

// Curated swatches that read well as a UI accent against the dark canvas.
// Each one is a sane standalone choice; the native color wheel below
// covers everything else.
const COLOR_PRESETS = [
  '#f59e0b', // amber-500 (default, yellow-orange)
  '#f97316', // orange-500
  '#ef4444', // red-500 (the legacy signature red)
  '#ec4899', // pink-500
  '#a855f7', // purple-500
  '#3b82f6', // blue-500
  '#06b6d4', // cyan-500
  '#10b981', // emerald-500
  '#84cc16', // lime-500
  '#eab308', // yellow-500
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function ThemePicker({ onClose }: { onClose: () => void }) {
  const currentColor = useThemeStore((s) => s.color);
  const storeHeadings = useThemeStore((s) => s.headings);
  const storeLock = useThemeStore((s) => s.lock);
  const updateTheme = useThemeStore((s) => s.updateTheme);
  const user = useAuthStore((s) => s.user);

  const [color, setColor] = useState(currentColor);
  const [headings, setHeadings] = useState<ThemePrefs>(storeHeadings);
  const [lock, setLock] = useState(storeLock);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Preview the candidate default heading colours in open editors while the
  // dialog is open (what an account without its own colours will see);
  // revert to this admin's own effective colours on close unless saved.
  const initialHeadings = useRef(
    resolveEffectiveHeadings({ headings: storeHeadings, lock: storeLock }, resolvePrefs(user).theme).headings,
  );
  const saved = useRef(false);
  useEffect(() => () => {
    if (!saved.current) applyHeadingColors(initialHeadings.current);
  }, []);
  const handleHeadingsChange = (t: ThemePrefs) => {
    setHeadings(t);
    applyHeadingColors(t);
  };

  const dirty =
    color.toLowerCase() !== currentColor.toLowerCase() ||
    JSON.stringify(headings) !== JSON.stringify(storeHeadings) ||
    lock !== storeLock;

  const handleSave = async () => {
    if (!HEX_RE.test(color)) {
      setError('color must be a #RRGGBB hex value');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateTheme({ color, headings, lock });
      saved.current = true;
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setColor(DEFAULT_THEME_COLOR);
    setError(null);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-3">
          <div className="flex items-center gap-2">
            <Palette size={14} style={{ color }} />
            <span className="text-[11px] font-bold uppercase tracking-widest">Theme</span>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-[hsl(var(--accent))]" title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
            The accent colour and default note heading colours for the entire workspace. Affects every user; saved on the server.
          </p>

          {/* Live preview swatches */}
          <div className="flex items-center gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-3">
            <div
              className="h-12 w-12 shrink-0 rounded-full border border-[hsl(var(--border))]"
              style={{ backgroundColor: color }}
              aria-hidden
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="font-mono text-[11px] uppercase text-[hsl(var(--muted-foreground))]">
                {HEX_RE.test(color) ? color.toUpperCase() : '—'}
              </div>
              <button
                type="button"
                className="self-start rounded-md px-2.5 py-1 text-[11px] font-medium text-white"
                style={{ backgroundColor: color }}
              >
                Preview button
              </button>
            </div>
          </div>

          {/* Presets */}
          <div>
            <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Presets
            </label>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  title={c}
                  className={`h-7 w-7 rounded-full border transition ${
                    color.toLowerCase() === c.toLowerCase()
                      ? 'border-white ring-2 ring-white/40'
                      : 'border-[hsl(var(--border))] hover:border-white/60'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          {/* Color wheel (OS-native picker) + hex */}
          <div>
            <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Custom
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={HEX_RE.test(color) ? color : DEFAULT_THEME_COLOR}
                onChange={(e) => setColor(e.target.value)}
                title="Open color wheel"
                className="h-9 w-12 cursor-pointer rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] p-0.5"
              />
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="#rrggbb"
                className="flex-1 rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1.5 font-mono text-xs outline-none focus:border-[hsl(var(--primary))]"
              />
              <button
                type="button"
                onClick={handleReset}
                title={`Reset to default (${DEFAULT_THEME_COLOR})`}
                className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2 py-1.5 text-[11px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
              >
                <RotateCcw size={11} /> Default
              </button>
            </div>
          </div>

          {/* Default heading colours for everyone + the hard-lock */}
          <div>
            <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Note Headings
            </label>
            <p className="mb-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">
              Default heading colours for every account. Users can pick their own unless you lock them.
            </p>
            <HeadingColorPicker value={headings} onChange={handleHeadingsChange} />
            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-2.5 text-[11px]">
              <input
                type="checkbox"
                checked={lock}
                onChange={(e) => setLock(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="flex items-center gap-1 font-medium">
                  <Lock size={11} /> Hardlock heading colours
                </span>
                <span className="block text-[10px] text-[hsl(var(--muted-foreground))]">
                  Force these colours on everyone. Users' own choices are kept but ignored until you unlock.
                </span>
              </span>
            </label>
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
  );
}
