import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_UI_THEME,
  UI_THEMES,
  UI_THEME_STORAGE_KEY,
  isUiTheme,
  normalizeUiTheme,
  applyUiTheme,
  readCachedUiTheme,
} from '@/themes/registry';
import { resolvePrefs, type EditorPrefs } from '@/lib/editor-prefs';

const LAST = UI_THEMES[UI_THEMES.length - 1]!.id;

describe('theme registry', () => {
  it('declares at least the default theme, with unique ids', () => {
    const ids = UI_THEMES.map((t) => t.id);
    expect(ids).toContain(DEFAULT_UI_THEME);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('recognises registered ids and nothing else', () => {
    for (const t of UI_THEMES) expect(isUiTheme(t.id)).toBe(true);
    expect(isUiTheme('neon')).toBe(false);
    expect(isUiTheme('')).toBe(false);
    expect(isUiTheme(undefined)).toBe(false);
    expect(isUiTheme(42)).toBe(false);
  });

  it('normalises anything unknown to the default', () => {
    expect(normalizeUiTheme('neon')).toBe(DEFAULT_UI_THEME);
    expect(normalizeUiTheme(null)).toBe(DEFAULT_UI_THEME);
    for (const t of UI_THEMES) expect(normalizeUiTheme(t.id)).toBe(t.id);
  });
});

describe('applyUiTheme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-ui-theme');
    localStorage.removeItem(UI_THEME_STORAGE_KEY);
  });

  it('stamps the html element and remembers the choice for the next load', () => {
    applyUiTheme(LAST);
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe(LAST);
    expect(readCachedUiTheme()).toBe(LAST);
  });

  it('falls back to the default for an unknown id and never caches garbage', () => {
    applyUiTheme('neon');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe(DEFAULT_UI_THEME);
    localStorage.setItem(UI_THEME_STORAGE_KEY, 'neon');
    expect(readCachedUiTheme()).toBe(DEFAULT_UI_THEME);
  });
});

describe('resolvePrefs.uiTheme', () => {
  it('defaults to the registry default and drops unknown values', () => {
    expect(resolvePrefs(null).uiTheme).toBe(DEFAULT_UI_THEME);
    const bogus = { uiTheme: 'neon' } as unknown as Partial<EditorPrefs>;
    expect(resolvePrefs({ prefs: bogus }).uiTheme).toBe(DEFAULT_UI_THEME);
    expect(resolvePrefs({ prefs: { uiTheme: LAST } }).uiTheme).toBe(LAST);
  });
});
