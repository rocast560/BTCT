// ─────────────────────────────────────────────────────────────────────────
// Interface themes (the overall look, as opposed to the accent colour).
//
// This file is the ONLY place a theme is declared. The switch in the sidebar
// header, the "Interface" section of the Profile editor, the prefs
// validator and the <html data-ui-theme="…"> stamp all read `UI_THEMES`, so
// adding or removing a theme is an edit here plus its stylesheet.
//
// How the themes are layered:
//   • `classic` is the base look: src/index.css + the Tailwind utilities in
//     the components. It has no stylesheet of its own.
//   • `glass` is src/themes/glass.css, every rule scoped under
//     `html[data-ui-theme="glass"]`, imported once in src/main.tsx. It
//     restyles the surfaces the components already render; it adds no
//     components and no JavaScript.
//
// To remove the glass theme: delete src/themes/glass.css, its import in
// src/main.tsx, and the `glass` entry below. Accounts that had it selected
// fall back to the default on their next load.
//
// To make glass the only look: set DEFAULT_UI_THEME to 'glass' and delete
// the `classic` entry; index.css stays, because glass builds on it.
// ─────────────────────────────────────────────────────────────────────────

export interface UiThemeDef {
  id: string;
  label: string;
  description: string;
}

export const UI_THEMES = [
  {
    id: 'classic',
    label: 'Classic',
    description: 'The original flat dark-grey interface.',
  },
  {
    id: 'glass',
    label: 'Glass',
    description: 'Floating translucent panels in the style of Apple’s Liquid Glass, same dark-grey palette.',
  },
] as const satisfies readonly UiThemeDef[];

export type UiThemeId = (typeof UI_THEMES)[number]['id'];

export const DEFAULT_UI_THEME: UiThemeId = 'classic';

/** localStorage key for the last applied theme, so the login screen paints right. */
export const UI_THEME_STORAGE_KEY = 'btct.ui-theme';

export function isUiTheme(value: unknown): value is UiThemeId {
  return typeof value === 'string' && UI_THEMES.some((t) => t.id === value);
}

export function normalizeUiTheme(value: unknown): UiThemeId {
  return isUiTheme(value) ? value : DEFAULT_UI_THEME;
}

export function readCachedUiTheme(): UiThemeId {
  try {
    return normalizeUiTheme(localStorage.getItem(UI_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_UI_THEME;
  }
}

/**
 * Stamp the theme on <html> (where the stylesheets look for it) and remember
 * it for the next load. Safe to call before React mounts. Returns the theme
 * actually applied.
 */
export function applyUiTheme(value: unknown): UiThemeId {
  const id = normalizeUiTheme(value);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-ui-theme', id);
  }
  try {
    localStorage.setItem(UI_THEME_STORAGE_KEY, id);
  } catch {
    /* private mode or blocked storage: the attribute still applies */
  }
  return id;
}

/** The theme after `current` in registry order (wraps), for a one-button toggle. */
export function nextUiTheme(current: unknown): UiThemeId {
  const idx = UI_THEMES.findIndex((t) => t.id === current);
  return (UI_THEMES[(idx + 1) % UI_THEMES.length] ?? UI_THEMES[0]).id;
}
