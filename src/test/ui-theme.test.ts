import { describe, it, expect } from 'vitest';
import { UI_THEME, applyUiTheme } from '@/themes/registry';
import { resolvePrefs, type EditorPrefs } from '@/lib/editor-prefs';

describe('interface look', () => {
  it('is Glass, stamped on <html>', () => {
    document.documentElement.removeAttribute('data-ui-theme');
    applyUiTheme();
    expect(UI_THEME).toBe('glass');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('glass');
  });

  it('ignores a uiTheme pref left over from before the switch', () => {
    const stale = { uiTheme: 'classic' } as unknown as Partial<EditorPrefs>;
    const prefs = resolvePrefs({ prefs: stale });
    expect('uiTheme' in prefs).toBe(false);
  });
});
