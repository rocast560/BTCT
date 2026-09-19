// Entry points for the Typst report tab exist only behind features.typst.
// WorkspaceOverview only renders the action when there is an active
// workspace, so both cases seed activeWorkspaceId: the "flag off" case
// proves the flag hides it, not the missing workspace.
import { describe, it, expect, beforeEach } from 'vitest';
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
