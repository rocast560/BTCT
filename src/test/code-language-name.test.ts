import { describe, it, expect } from 'vitest';
import { DEFAULT_CODE_LANGUAGE, displayLanguageName } from '@/lib/code-theme';

describe('displayLanguageName', () => {
  it('canonicalises a name to the picker\'s own casing', () => {
    // The regression: a new code block stored 'shell' and its button read
    // "shell", while the picker listed — and, once clicked, stored — "Shell".
    expect(displayLanguageName('shell')).toBe('Shell');
    expect(displayLanguageName('Shell')).toBe('Shell');
    expect(displayLanguageName('SHELL')).toBe('Shell');
  });

  it('resolves aliases to the canonical name', () => {
    expect(displayLanguageName('sh')).toBe('Shell');
    expect(displayLanguageName('bash')).toBe('Shell');
    expect(displayLanguageName('zsh')).toBe('Shell');
    expect(displayLanguageName('js')).toBe('JavaScript');
    expect(displayLanguageName('ts')).toBe('TypeScript');
  });

  it('leaves an unknown language for the caller to pass through', () => {
    expect(displayLanguageName('nonexistent-lang')).toBeNull();
    expect(displayLanguageName('')).toBeNull();
    expect(displayLanguageName(null)).toBeNull();
    expect(displayLanguageName(undefined)).toBeNull();
  });

  it('exports a default that matches what the picker would store', () => {
    expect(DEFAULT_CODE_LANGUAGE).toBe('Shell');
    expect(displayLanguageName(DEFAULT_CODE_LANGUAGE)).toBe(DEFAULT_CODE_LANGUAGE);
  });
});
