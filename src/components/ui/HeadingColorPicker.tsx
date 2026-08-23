import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { HEADING_LEVELS, type HeadingLevel, type ThemePrefs } from '@/lib/editor-prefs';

/**
 * Picker for note heading colours, shared by the per-user Profile editor
 * and the admin Theme dialog. Edits a `ThemePrefs` value: one colour for
 * every heading level plus optional per-level overrides. "Auto" clears a
 * colour back to "inherit the body text colour".
 */

const PRESETS = [
  '#ffffff', '#f59e0b', '#f97316', '#ef4444',
  '#ec4899', '#a855f7', '#3b82f6', '#06b6d4',
  '#10b981', '#84cc16', '#eab308', '#94a3b8',
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function HeadingColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: ThemePrefs;
  onChange: (next: ThemePrefs) => void;
  disabled?: boolean;
}) {
  const [advanced, setAdvanced] = useState(Object.keys(value.headings).length > 0);

  const setAll = (hex: string | null) => onChange({ ...value, headingColor: hex });
  const setLevel = (level: HeadingLevel, hex: string | null) => {
    const headings = { ...value.headings };
    if (hex) headings[level] = hex;
    else delete headings[level];
    onChange({ ...value, headings });
  };
  const colorFor = (level: HeadingLevel): string | undefined =>
    value.headings[level] ?? value.headingColor ?? undefined;

  return (
    <div className={disabled ? 'pointer-events-none opacity-50' : ''} aria-disabled={disabled}>
      {/* Sample so the choice is visible even with no editor open. */}
      <div className="mb-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2">
        <div className="text-base font-bold leading-tight" style={{ color: colorFor('h1') }}>Heading 1</div>
        <div className="text-sm font-bold leading-tight" style={{ color: colorFor('h2') }}>Heading 2</div>
        <div className="text-[11px] text-[hsl(var(--muted-foreground))]">Body text is not affected.</div>
      </div>

      {/* One colour for every level */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setAll(null)}
          title="Inherit the body text colour"
          className={`h-6 rounded-full border px-2 text-[10px] transition ${
            value.headingColor === null
              ? 'border-white ring-2 ring-white/40'
              : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:border-white/60'
          }`}
        >
          Auto
        </button>
        {PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setAll(c)}
            title={c}
            className={`h-6 w-6 rounded-full border transition ${
              (value.headingColor ?? '').toLowerCase() === c.toLowerCase()
                ? 'border-white ring-2 ring-white/40'
                : 'border-[hsl(var(--border))] hover:border-white/60'
            }`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="color"
          value={value.headingColor ?? '#ffffff'}
          onChange={(e) => setAll(e.target.value)}
          title="Open colour wheel"
          className="h-8 w-10 cursor-pointer rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
        />
        <HexInput value={value.headingColor} onCommit={setAll} placeholder="inherit" />
      </div>

      {/* Per-level overrides */}
      <button
        type="button"
        onClick={() => setAdvanced((a) => !a)}
        className="mt-2 flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
      >
        {advanced ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        Per-level overrides{Object.keys(value.headings).length > 0 ? ` (${Object.keys(value.headings).length})` : ''}
      </button>
      {advanced && (
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
          {HEADING_LEVELS.map((level) => (
            <div key={level} className="flex items-center gap-1.5">
              <span className="w-5 font-mono text-[10px] uppercase text-[hsl(var(--muted-foreground))]">{level}</span>
              <input
                type="color"
                value={value.headings[level] ?? value.headingColor ?? '#ffffff'}
                onChange={(e) => setLevel(level, e.target.value)}
                className="h-6 w-8 cursor-pointer rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
              />
              <HexInput value={value.headings[level] ?? null} onCommit={(hex) => setLevel(level, hex)} placeholder="auto" compact />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Hex text field that only commits a complete #RRGGBB (or empty, meaning
 * "auto"); partial typing stays local so a half-typed value never reaches
 * the live preview.
 */
function HexInput({
  value,
  onCommit,
  placeholder,
  compact,
}: {
  value: string | null;
  onCommit: (hex: string | null) => void;
  placeholder: string;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState(value ?? '');
  // Re-sync when the committed value changes from outside (preset click).
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value ?? '');
  }
  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        const t = v.trim();
        if (!t) onCommit(null);
        else if (HEX_RE.test(t)) onCommit(t);
      }}
      className={`${compact ? 'w-20 px-1.5 py-0.5 text-[10px]' : 'flex-1 px-2 py-1.5 text-xs'} rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] font-mono outline-none focus:border-[hsl(var(--primary))]`}
    />
  );
}
