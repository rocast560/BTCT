import { describe, it, expect } from 'vitest';
import { HIGHLIGHT_COLORS, highlightMark, toggleHighlightCommand, highlightPlugin } from '@/lib/highlight-plugin';

describe('highlight-plugin', () => {
  it('exports the expected palette of colours', () => {
    expect(HIGHLIGHT_COLORS).toEqual(['yellow', 'green', 'blue', 'pink', 'orange', 'purple', 'red']);
  });

  it('declares a highlight mark', () => {
    expect(highlightMark).toBeDefined();
  });

  it('declares the ToggleHighlight command', () => {
    expect(toggleHighlightCommand).toBeDefined();
    expect(toggleHighlightCommand.key).toBe('ToggleHighlight');
  });

  it('exports the plugin as a flat array containing both pieces', () => {
    expect(Array.isArray(highlightPlugin)).toBe(true);
    expect(highlightPlugin.length).toBeGreaterThanOrEqual(2);
  });
});
