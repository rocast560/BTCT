// ─────────────────────────────────────────────────────────────────────────
// App-level host for editing a note image's asset:
//   • the right-click menu over a note image (from the `imageMenu` store flag)
//   • the crop/blur editor dialog (from the `editingAssetId` store flag)
//
// The editor is the same non-destructive PlaceScreenshotDialog the report and
// the Assets Manager use, in `hidePlacement` mode: it edits the shared asset's
// crop/blur metadata, never the original bytes, so a blur can always be
// removed. The note image (asset_image node view) re-renders from the asset,
// so the change shows in the note immediately.
// ─────────────────────────────────────────────────────────────────────────

import { Suspense, lazy, useEffect } from 'react';
import { EyeOff, FolderOpen } from 'lucide-react';
import { useAppStore } from '@/stores';
import { Portal } from '@/components/ui/Portal';
import { openAssetImageEditor } from '@/lib/note-image-paste';
import { v4 as uuidv4 } from 'uuid';

const PlaceScreenshotDialog = lazy(() =>
  import('@/components/typst/PlaceScreenshotDialog').then((m) => ({ default: m.PlaceScreenshotDialog })),
);

export function AssetImageEditor() {
  const imageMenu = useAppStore((s) => s.imageMenu);
  const setImageMenu = useAppStore((s) => s.setImageMenu);
  const editingAssetId = useAppStore((s) => s.editingAssetId);
  const setEditingAssetId = useAppStore((s) => s.setEditingAssetId);
  const assets = useAppStore((s) => s.typstAssets);
  const setTypstAssetCrop = useAppStore((s) => s.setTypstAssetCrop);
  const renameTypstAsset = useAppStore((s) => s.renameTypstAsset);
  const openTab = useAppStore((s) => s.openTab);

  // Close the context menu on any outside click / Escape.
  useEffect(() => {
    if (!imageMenu) return;
    const close = () => setImageMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setImageMenu(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); };
  }, [imageMenu, setImageMenu]);

  const editingAsset = editingAssetId ? assets.find((a) => a.id === editingAssetId) ?? null : null;

  return (
    <>
      {imageMenu && (
        <Portal>
          <div
            className="fixed z-[130] min-w-[190px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--popover))] py-1 shadow-2xl"
            style={{ left: imageMenu.x, top: imageMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => openAssetImageEditor(imageMenu.assetId)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
            >
              <EyeOff size={12} /> Blur / edit image
            </button>
            <button
              onClick={() => {
                setImageMenu(null);
                openTab({ id: uuidv4(), kind: 'assets', entityId: 'assets', title: 'Assets' });
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
            >
              <FolderOpen size={12} /> Open in Assets Manager
            </button>
          </div>
        </Portal>
      )}

      {editingAsset && (
        <Portal>
          <Suspense fallback={null}>
            <PlaceScreenshotDialog
              asset={editingAsset}
              source=""
              hidePlacement
              onApply={(crop, blurs) => { void setTypstAssetCrop(editingAsset.id, crop, blurs); setEditingAssetId(null); }}
              onUnplace={() => setEditingAssetId(null)}
              onAddSlot={() => { /* no slots outside the report */ }}
              onRename={(stem) => { void renameTypstAsset(editingAsset.id, stem); }}
              onClose={() => setEditingAssetId(null)}
            />
          </Suspense>
        </Portal>
      )}
    </>
  );
}
