import { describe, it, expect } from 'vitest';
import { resolveBlurStrengthPolicy, resolvePrefs } from '@/lib/editor-prefs';

describe('resolveBlurStrengthPolicy', () => {
  it('falls back builtin → admin → user, per style', () => {
    expect(resolveBlurStrengthPolicy(null, { gaussian: null, pixelate: null }))
      .toEqual({ gaussian: 1, pixelate: 1 });
    expect(resolveBlurStrengthPolicy({ gaussian: 2, pixelate: 0.5 }, { gaussian: null, pixelate: null }))
      .toEqual({ gaussian: 2, pixelate: 0.5 });
    expect(resolveBlurStrengthPolicy({ gaussian: 2, pixelate: 0.5 }, { gaussian: 1.5, pixelate: null }))
      .toEqual({ gaussian: 1.5, pixelate: 0.5 });
  });

  it('clamps out-of-range and drops malformed values', () => {
    expect(resolveBlurStrengthPolicy({ gaussian: 99, pixelate: 0 }, { gaussian: null, pixelate: null }))
      .toEqual({ gaussian: 3, pixelate: 0.25 });
    expect(resolveBlurStrengthPolicy(
      { gaussian: Number.NaN } as { gaussian: number },
      { gaussian: null, pixelate: null },
    ).gaussian).toBe(1);
  });
});

describe('resolvePrefs blurDefaults', () => {
  it('defaults to inherit and keeps valid stored values', () => {
    expect(resolvePrefs(null).blurDefaults).toEqual({ gaussian: null, pixelate: null });
    expect(resolvePrefs({ prefs: { blurDefaults: { gaussian: 2.5, pixelate: null } } }).blurDefaults)
      .toEqual({ gaussian: 2.5, pixelate: null });
  });

  it('drops malformed values back to inherit', () => {
    const prefs = { blurDefaults: { gaussian: 'strong', pixelate: 7 } } as never;
    expect(resolvePrefs({ prefs }).blurDefaults).toEqual({ gaussian: null, pixelate: 3 });
  });
});
