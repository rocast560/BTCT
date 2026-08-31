// ─────────────────────────────────────────────────────────────────────────
// Standalone Assets Manager tab.
//
// The same folder browser and non-destructive crop/blur image editor as the
// Typst report's Assets rail, opened as its own tab so it's reachable while
// taking notes. It shares one state with the report (the `typstAssets` and
// `assetFolders` shared tables), so a folder you make here, an image you drop,
// a crop or a blur is the same object the report sees, and a blur can always
// be removed again because the original bytes are never overwritten.
//
// It reuses `TypstAssetsPanel` in `standalone` mode: no Typst source, so the
// figure-placement UI is hidden and the editor is crop + blur only.
// ─────────────────────────────────────────────────────────────────────────

import { useAppStore } from '@/stores';
import { TypstAssetsPanel } from './TypstAssetsPanel';

const noop = () => { /* standalone: no Typst document to rewrite */ };

export function AssetsManager() {
  const workspaceId = useAppStore((s) => s.activeWorkspaceId);

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
        Select a workspace to manage assets.
      </div>
    );
  }

  return (
    <div className="h-full">
      <TypstAssetsPanel
        source=""
        onSourceChange={noop}
        fullscreen
        onToggleFullscreen={noop}
        onHide={noop}
        standalone
      />
    </div>
  );
}
