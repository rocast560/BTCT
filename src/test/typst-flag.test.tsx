// Entry points for the Typst report tab exist only behind features.typst.
// WorkspaceOverview only renders the action when there is an active
// workspace, so both cases seed activeWorkspaceId: the "flag off" case
// proves the flag hides it, not the missing workspace.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useThemeStore } from '@/stores/theme-store';
import { useAppStore } from '@/stores';
import { WorkspaceOverview } from '@/components/ui/WorkspaceOverview';
import { typstTabState } from '@/components/ui/SplitContainer';

describe('Typst entry points follow features.typst', () => {
  beforeEach(() => {
    useThemeStore.setState({ features: { typst: false } });
    useAppStore.setState({
      activeWorkspaceId: 'ws-1',
      workspaces: [],
      pages: [],
      nmapScans: [],
      typstAssets: [],
    });
  });

  it('hides the report action when the flag is off', () => {
    render(<WorkspaceOverview />);
    expect(screen.queryByText('Write the report')).toBeNull();
  });

  it('shows it when the flag is on', () => {
    useThemeStore.setState({ features: { typst: true } });
    render(<WorkspaceOverview />);
    expect(screen.getByText('Write the report')).toBeTruthy();
  });
});

// A restored Report tab must stay inert (no TypstView render, no compiler
// chunk request) until settings have actually loaded, so a flag-off box
// never renders (and never fetches) the editor for a tab that survived from
// an earlier, flag-on session in localStorage.
describe('typstTabState (SplitContainer render gate for a typst tab)', () => {
  it('renders nothing while settings have not loaded yet, regardless of the flag', () => {
    expect(typstTabState({ typst: false }, false)).toBe('loading');
    expect(typstTabState({ typst: true }, false)).toBe('loading');
  });

  it('renders the editor once loaded and the flag is on', () => {
    expect(typstTabState({ typst: true }, true)).toBe('on');
  });

  it('renders the off notice once loaded and the flag is off', () => {
    expect(typstTabState({ typst: false }, true)).toBe('off');
  });
});

// Regression guard: theme-store's `loaded` flips true from two independent
// sources, the GET /api/settings fetch (which carries `features`) AND the
// live `settingsPublic` mirror (an IndexedDB replay or websocket sync, which
// never touches `features`). The Report tab's render gate must key off a
// flag that only the fetch sets, or a flag-ON server can flash "Report tab
// is turned off" (or hang there indefinitely if the mirror wins a race
// against a slow/failed fetch).
describe('theme-store featuresLoaded (the render gate must not key off `loaded`)', () => {
  beforeEach(() => {
    useThemeStore.setState({ loaded: false, featuresLoaded: false, updatedAt: 0, features: { typst: false } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applyServerTheme (the settingsPublic mirror path) flips `loaded` without touching `featuresLoaded`', () => {
    useThemeStore.getState().applyServerTheme({});
    expect(useThemeStore.getState().loaded).toBe(true);
    expect(useThemeStore.getState().featuresLoaded).toBe(false);
  });

  it('a resolved settings fetch sets `features` and `featuresLoaded` together', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ features: { typst: true }, themeUpdatedAt: 1 }),
    }));
    await useThemeStore.getState().loadTheme();
    expect(useThemeStore.getState().features.typst).toBe(true);
    expect(useThemeStore.getState().featuresLoaded).toBe(true);
  });

  it('a rejected settings fetch leaves `featuresLoaded` false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await useThemeStore.getState().loadTheme();
    expect(useThemeStore.getState().featuresLoaded).toBe(false);
  });
});
