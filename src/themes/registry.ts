// ─────────────────────────────────────────────────────────────────────────
// Interface look.
//
// BTCT ships one look: Glass (src/themes/glass.css), an Apple-style skin on
// the dark-grey palette. It restyles the base stylesheet (src/index.css plus
// the Tailwind utilities in the components) under html[data-ui-theme="glass"].
// index.html carries the attribute so the first paint is already Glass, and
// main.tsx stamps it again at boot. The Classic theme and the per-account
// switcher were removed on 2026-08-28; a `prefs.uiTheme` left on an account
// from before that is ignored.
// ─────────────────────────────────────────────────────────────────────────

export const UI_THEME = 'glass' as const;

/** Stamp the look on <html>. Safe to call before React mounts. */
export function applyUiTheme(): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-ui-theme', UI_THEME);
  }
}
