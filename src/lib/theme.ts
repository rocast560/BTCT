/**
 * Theme color helpers. The whole app is built around HSL CSS variables —
 * `--primary` and `--ring` drive every accent surface, focus ring, link
 * color, attack-chain glow, etc. (see src/index.css). To recolor the app
 * we just rewrite those two variables on `:root`. Hex is what users
 * (and the SQLite settings row) speak, so we convert at the edge.
 */

// Yellow-orange (amber-500). Picked as a softer, more pen-test-flavored
// default than the original signature red.
export const DEFAULT_THEME_COLOR = '#f59e0b';

export interface Hsl {
  h: number; // 0-360
  s: number; // 0-100
  l: number; // 0-100
}

export function hexToHsl(hex: string): Hsl | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  const captured = m?.[1];
  if (!captured) return null;
  const n = parseInt(captured, 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// CSS variables in index.css are written as raw HSL triplets (e.g.
// `0 78% 52%`) so callers can do `hsl(var(--primary) / 0.5)`. We must
// match that exact shape.
export function hslTriplet(hex: string): string | null {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;
  return `${hsl.h} ${hsl.s}% ${hsl.l}%`;
}

export function applyThemeColor(hex: string): void {
  if (typeof document === 'undefined') return;
  const triplet = hslTriplet(hex);
  if (!triplet) return;
  const root = document.documentElement;
  root.style.setProperty('--primary', triplet);
  root.style.setProperty('--ring', triplet);
}
