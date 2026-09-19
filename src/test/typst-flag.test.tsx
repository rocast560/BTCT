// Entry points for the Typst report tab exist only behind features.typst.
// WorkspaceOverview only renders the action when there is an active
// workspace, so both cases seed activeWorkspaceId: the "flag off" case
// proves the flag hides it, not the missing workspace.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useThemeStore } from '@/stores/theme-store';
import { useAppStore } from '@/stores';
import { WorkspaceOverview } from '@/components/ui/WorkspaceOverview';

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
