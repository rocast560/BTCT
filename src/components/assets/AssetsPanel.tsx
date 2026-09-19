// ─────────────────────────────────────────────────────────────────────────
// Assets browser: the screenshots a note can embed.
//
// Assets live in a folder hierarchy (engagement phase, host, whatever shape
// the work wants). Folders are organizational only: an image keeps its flat
// `/assets/<name>` path wherever it sits, so re-filing one never breaks a
// note that references it. The tree mirrors the sidebar's page tree.
//
// Clicking a thumbnail opens the crop-and-redact editor. Both are render-time
// metadata on the record, never baked into the upload, so the thumbnails show
// the cropped result while the original bytes stay recoverable.
//
// The same panel is the Typst report's assets rail, via the optional `typst`
// prop. With it set, a thumbnail opens the figure-placement dialog instead of
// the plain crop editor, each card gets an insert-at-the-caret button, and the
// layout stacks for a narrow rail. Without it (the Assets Manager tab) none of
// that code is even downloaded: the dialog is a `lazy()` import.
// ─────────────────────────────────────────────────────────────────────────

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ChevronRight, Crop, EyeOff, Folder, FolderPlus, ImagePlus,
  Loader2, MapPin, Pencil, Plus, Trash2, Upload,
} from 'lucide-react';
import { useAppStore } from '@/stores';
import type { AssetFolder, BlurRegion, CropRect, ID, TypstAsset } from '@/types';
import type { ScreenshotSlot } from '@/lib/typst-placeholders';
import { blursKey, hasBlurs } from '@/lib/blur-math';
import { assetsInFolder, childFolders, folderTrail, isDescendantFolder } from '@/lib/asset-folders';
import { assetPath, isFullFrame, resolveAssetBytes } from '@/lib/assets';
import { ENCODABLE_FORMATS, formatFromFilename, mimeForFormat } from '@/lib/image-format';
import { ImageEditorDialog } from './ImageEditorDialog';
import { Portal } from '@/components/ui/Portal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

// Lazy, and referenced only under `typst`: the Assets Manager tab must not
// pull the figure-placement dialog (and with it the Typst geometry and
// placeholder code) into its chunk. `ScreenshotSlot` above is a type-only
// import, so it is erased rather than linked.
const PlaceScreenshotDialog = lazy(() =>
  import('@/components/typst/PlaceScreenshotDialog').then((m) => ({ default: m.PlaceScreenshotDialog })),
);

/**
 * What the Typst report tab hands the panel to turn it into its assets rail.
 * Absent everywhere else, which is what keeps Typst code out of the Assets
 * Manager tab.
 *
 * Every source rewrite is a callback rather than something the panel does
 * itself: the report tab owns the source `Y.Text`, and it is the only place
 * that may write to it (invariant #3b).
 */
export interface TypstPanelMode {
  /** Live Typst source: the dialog reads the slots and page geometry from it. */
  source: string;
  /** Caption of the figure each asset path currently fills, keyed by path. */
  placements: ReadonlyMap<string, string>;
  /** Put an `#image(…)` for this asset at the editor's caret. */
  onInsert: (asset: TypstAsset) => void;
  /**
   * Commit the framing, and, when `slot` is set, write `path` into that slot
   * (`null` to empty it). `heightPt` is set when the figure's height changed.
   */
  onPlace: (
    asset: TypstAsset,
    crop: CropRect | null,
    blurs: BlurRegion[] | null,
    slot: ScreenshotSlot | null,
    path: string | null,
    heightPt: number | null,
  ) => void;
  /** Append a new empty figure slot to the document. */
  onAddSlot: (caption: string) => void;
  /** Rename the asset's file stem and repoint the document's references. */
  onRename: (asset: TypstAsset, stem: string) => void;
  /** Click-to-reveal from the preview: select + flash this asset. */
  reveal?: { id: ID; nonce: number } | null;
}

/** Drag payload types for moving things between folders. */
const ASSET_DRAG = 'application/x-btct-asset';
const FOLDER_DRAG = 'application/x-btct-asset-folder';

/** Accept a dropped file only if it is an image we can store. */
function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|svg)$/.test(file.name.toLowerCase());
}

/**
 * Object URL for an asset's *rendered* bytes (cropped, if it has a crop).
 * Revokes on change so a long session doesn't leak blob URLs.
 */
function useAssetPreview(asset: TypstAsset): { url: string | null; error: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // Depend on the crop/blur *values*, not identity, so a re-render with
  // equal framing doesn't rebuild the blob.
  const cropKey = asset.crop
    ? `${asset.crop.x},${asset.crop.y},${asset.crop.w},${asset.crop.h}`
    : '';
  const blurKey = blursKey(asset.blurs);

  useEffect(() => {
    if (asset.kind !== 'image') return;
    let cancelled = false;
    let objUrl: string | null = null;
    setError(false);
    resolveAssetBytes(asset)
      .then((bytes) => {
        if (cancelled) return;
        // resolveAssetBytes normalizes bytes to the format the filename's
        // extension claims (when a canvas can produce it), so the blob type
        // has to follow the same rule rather than trusting the stored mime.
        const claimed = formatFromFilename(asset.filename);
        const type = claimed && ENCODABLE_FORMATS.has(claimed)
          ? mimeForFormat(claimed)
          : asset.mime;
        objUrl = URL.createObjectURL(
          new Blob([bytes.slice().buffer as ArrayBuffer], { type }),
        );
        setUrl(objUrl);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id, asset.kind, asset.mime, asset.filename, cropKey, blurKey]);

  return { url, error };
}

// Memoized: a thumbnail only actually changes when its asset record does,
// so a re-render of the grid does not rebuild every <img> in it.
const ImageCard = memo(function ImageCard({
  asset,
  placedIn,
  flash,
  onOpen,
  onDelete,
  onInsert,
  onDragStartAsset,
  registerEl,
}: {
  asset: TypstAsset;
  /** Caption of the figure this image currently fills, if any (Typst mode). */
  placedIn: string | null;
  /** Pulse-highlight this card. */
  flash: boolean;
  // Take the asset as an argument rather than closing over it, so the parent
  // can pass one stable callback instead of minting a new closure per card on
  // every render, which would defeat the memo above entirely.
  onOpen: (asset: TypstAsset) => void;
  onDelete: (asset: TypstAsset) => void;
  /** Typst mode only: insert a reference to this image at the caret. */
  onInsert?: (asset: TypstAsset) => void;
  onDragStartAsset: (e: React.DragEvent, asset: TypstAsset) => void;
  registerEl: (id: ID, el: HTMLDivElement | null) => void;
}) {
  const { url, error } = useAssetPreview(asset);
  const cropped = !isFullFrame(asset.crop);
  const blurred = hasBlurs(asset.blurs);

  return (
    <div
      ref={(el) => registerEl(asset.id, el)}
      draggable
      onDragStart={(e) => onDragStartAsset(e, asset)}
      className={`group relative overflow-hidden rounded border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.3)] ${flash ? 'asset-flash' : ''}`}
    >
      <button
        onClick={() => onOpen(asset)}
        title={placedIn ? `Placed in "${placedIn}": click to re-crop or move` : `Crop or redact ${asset.filename}`}
        className="block h-20 w-full"
      >
        {error ? (
          <span className="flex h-full items-center justify-center gap-1 text-[10px] text-[hsl(var(--status-red))]">
            <AlertTriangle size={11} /> missing
          </span>
        ) : url ? (
          <img src={url} alt={asset.filename} className="h-full w-full object-contain" />
        ) : (
          <span className="flex h-full items-center justify-center">
            <Loader2 size={13} className="animate-spin text-[hsl(var(--muted-foreground))]" />
          </span>
        )}
      </button>

      <div className="pointer-events-none absolute left-1 top-1 flex flex-col items-start gap-0.5">
        {cropped && (
          <span className="flex items-center gap-0.5 rounded bg-[hsl(var(--status-purple))] px-1 py-px text-[9px] font-semibold uppercase text-white">
            <Crop size={8} /> cropped
          </span>
        )}
        {blurred && (
          <span className="flex items-center gap-0.5 rounded bg-[hsl(var(--status-purple))] px-1 py-px text-[9px] font-semibold uppercase text-white">
            <EyeOff size={8} /> redacted
          </span>
        )}
        {placedIn && (
          <span className="flex items-center gap-0.5 rounded bg-[hsl(var(--primary))] px-1 py-px text-[9px] font-semibold uppercase text-[hsl(var(--primary-foreground))]">
            <MapPin size={8} /> placed
          </span>
        )}
      </div>

      {/* Hover actions */}
      <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {onInsert && (
          <button
            onClick={() => onInsert(asset)}
            title="Insert #image(…) at the cursor"
            className="rounded bg-black/60 p-1 text-white hover:bg-[hsl(var(--primary))]"
          >
            <Plus size={11} />
          </button>
        )}
        <button
          onClick={() => onDelete(asset)}
          title="Delete asset"
          className="rounded bg-black/60 p-1 text-white hover:bg-[hsl(var(--status-red))]"
        >
          <Trash2 size={11} />
        </button>
      </div>

      <div
        className="truncate border-t border-[hsl(var(--border))] px-1.5 py-1 font-mono text-[9px] text-[hsl(var(--muted-foreground))]"
        title={placedIn ? `${assetPath(asset)}: in "${placedIn}"` : assetPath(asset)}
      >
        {placedIn ?? asset.filename}
      </div>
    </div>
  );
});

// ── Folder tree ──────────────────────────────────────────────────────────

interface FolderNodeProps {
  folder: AssetFolder;
  folders: AssetFolder[];
  selected: ID | null;
  expanded: Set<ID>;
  counts: Map<string, number>;
  renamingId: ID | null;
  onSelect: (id: ID | null) => void;
  onToggle: (id: ID) => void;
  onStartRename: (id: ID | null) => void;
  onCommitRename: (id: ID, name: string) => void;
  onNewSubfolder: (parentId: ID) => void;
  onDeleteFolder: (folder: AssetFolder) => void;
  onDropInto: (e: React.DragEvent, folderId: ID | null) => void;
}

function FolderNode(props: FolderNodeProps) {
  const {
    folder, folders, selected, expanded, counts, renamingId,
    onSelect, onToggle, onStartRename, onCommitRename, onNewSubfolder, onDeleteFolder, onDropInto,
  } = props;
  const [dragOver, setDragOver] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const kids = childFolders(folders, folder.id);
  const isExpanded = expanded.has(folder.id);
  const renaming = renamingId === folder.id;
  const count = counts.get(folder.id) ?? 0;

  useEffect(() => {
    if (renaming) {
      setDraft(folder.name);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming]);

  const acceptsDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(ASSET_DRAG) ||
    e.dataTransfer.types.includes(FOLDER_DRAG) ||
    e.dataTransfer.types.includes('Files');

  return (
    <div className="atree-item">
      <div
        draggable={!renaming}
        data-active={selected === folder.id || undefined}
        onDragStart={(e) => {
          e.dataTransfer.setData(FOLDER_DRAG, folder.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => { if (acceptsDrag(e)) { e.preventDefault(); e.stopPropagation(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { setDragOver(false); onDropInto(e, folder.id); }}
        className={`group/row flex w-full items-center rounded-lg border border-transparent hover:bg-[hsl(var(--accent))] ${
          selected === folder.id ? 'bg-[hsl(var(--accent))]' : ''
        } ${dragOver ? 'ring-2 ring-[hsl(var(--primary))]' : ''}`}
      >
        {kids.length > 0 ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(folder.id); }}
            className="ml-0.5 shrink-0 rounded p-0.5 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            <ChevronRight size={10} className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span className="ml-0.5 inline-block w-[14px] shrink-0" aria-hidden />
        )}
        {renaming ? (
          <div className="flex flex-1 items-center gap-1.5 px-1 py-1.5">
            <Folder size={12} className="shrink-0 text-[hsl(var(--status-amber))]" />
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => onCommitRename(folder.id, draft)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCommitRename(folder.id, draft);
                if (e.key === 'Escape') onStartRename(null);
              }}
              className="min-w-0 flex-1 border-b border-[hsl(var(--primary))] bg-transparent text-[11px] outline-none"
            />
          </div>
        ) : (
          <button
            onClick={() => onSelect(folder.id)}
            onDoubleClick={() => onStartRename(folder.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1.5 text-[11px]"
            title={`${folder.name}${count ? ` (${count} asset${count === 1 ? '' : 's'})` : ''}`}
          >
            <Folder size={12} className="shrink-0 text-[hsl(var(--status-amber))]" />
            <span className="truncate">{folder.name}</span>
            {count > 0 && (
              <span className="ml-auto shrink-0 rounded-full bg-[hsl(var(--muted))] px-1.5 text-[9px] text-[hsl(var(--muted-foreground))]">
                {count}
              </span>
            )}
          </button>
        )}
        {!renaming && (
          <div className="mr-1 flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
            <button
              onClick={() => onNewSubfolder(folder.id)}
              title="New subfolder"
              className="rounded p-0.5 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
            >
              <FolderPlus size={11} />
            </button>
            <button
              onClick={() => onStartRename(folder.id)}
              title="Rename folder"
              className="rounded p-0.5 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
            >
              <Pencil size={11} />
            </button>
            <button
              onClick={() => onDeleteFolder(folder)}
              title="Delete folder (contents move up a level)"
              className="rounded p-0.5 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--status-red))]"
            >
              <Trash2 size={11} />
            </button>
          </div>
        )}
      </div>

      {isExpanded && kids.length > 0 && (
        <div className="atree-kids">
          {kids.map((child) => (
            <FolderNode key={child.id} {...props} folder={child} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────

export const AssetsPanel = memo(function AssetsPanel({ typst }: { typst?: TypstPanelMode }) {
  const assets = useAppStore((s) => s.typstAssets);
  const folders = useAppStore((s) => s.assetFolders);
  const addTypstAsset = useAppStore((s) => s.addTypstAsset);
  const deleteTypstAsset = useAppStore((s) => s.deleteTypstAsset);
  const setTypstAssetCrop = useAppStore((s) => s.setTypstAssetCrop);
  const renameTypstAsset = useAppStore((s) => s.renameTypstAsset);
  const createAssetFolder = useAppStore((s) => s.createAssetFolder);
  const renameAssetFolder = useAppStore((s) => s.renameAssetFolder);
  const moveAssetFolder = useAppStore((s) => s.moveAssetFolder);
  const deleteAssetFolder = useAppStore((s) => s.deleteAssetFolder);
  const moveTypstAssetToFolder = useAppStore((s) => s.moveTypstAssetToFolder);

  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TypstAsset | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Folder navigation. `null` is the root level.
  const [selectedFolder, setSelectedFolder] = useState<ID | null>(null);
  const [expanded, setExpanded] = useState<Set<ID>>(new Set());
  const [renamingId, setRenamingId] = useState<ID | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AssetFolder | null>(null);
  const [pendingDeleteAsset, setPendingDeleteAsset] = useState<TypstAsset | null>(null);
  const [flashId, setFlashId] = useState<ID | null>(null);
  const cardEls = useRef(new Map<ID, HTMLDivElement>());

  // A folder deleted remotely (or a workspace switch) must not leave the
  // grid pointing at a ghost.
  useEffect(() => {
    if (selectedFolder && !folders.some((f) => f.id === selectedFolder)) setSelectedFolder(null);
  }, [folders, selectedFolder]);

  const live = useMemo(() => assets.filter((a) => !a.deletedAt), [assets]);
  const images = useMemo(
    () => assetsInFolder(live.filter((a) => a.kind === 'image'), selectedFolder),
    [live, selectedFolder],
  );
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of live) {
      const key = a.folderId ?? '';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [live]);
  const rootFolders = useMemo(() => childFolders(folders, null), [folders]);
  const trail = useMemo(() => folderTrail(folders, selectedFolder), [folders, selectedFolder]);

  const ingest = useCallback(
    async (files: FileList | File[], folderId: ID | null) => {
      const list = [...files];
      if (!list.length) return;
      setBusy(true);
      setError(null);
      const failures: string[] = [];
      let firstImage: TypstAsset | null = null;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      // Sequential rather than parallel: filename de-duplication reads the
      // current asset list, so two concurrent uploads of `shot.png` would
      // both see the name as free and collide in the virtual FS.
      for (const file of list) {
        if (!isImageFile(file)) {
          failures.push(`${file.name}: not an image`);
          continue;
        }
        try {
          const created = await addTypstAsset(file, 'image', folderId);
          if (!firstImage) firstImage = created;
        } catch (e) {
          failures.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setBusy(false);
      if (failures.length) setError(failures.join('\n'));
      // Drop → immediately offer crop + redaction, which is usually why a
      // screenshot went in. Only for the first of a batch, so dragging in
      // ten files doesn't open ten dialogs.
      if (firstImage) setEditing(firstImage);
    },
    [addTypstAsset],
  );

  /** Panel-wide drop: OS files land in the folder currently being viewed. */
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.types.includes(ASSET_DRAG) || e.dataTransfer.types.includes(FOLDER_DRAG)) return;
      if (e.dataTransfer?.files?.length) void ingest(e.dataTransfer.files, selectedFolder);
    },
    [ingest, selectedFolder],
  );

  /** Drop onto a folder row (or the root row, folderId = null). */
  const onDropInto = useCallback(
    (e: React.DragEvent, folderId: ID | null) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const assetId = e.dataTransfer.getData(ASSET_DRAG);
      if (assetId) { void moveTypstAssetToFolder(assetId, folderId); return; }
      const movedFolder = e.dataTransfer.getData(FOLDER_DRAG);
      if (movedFolder) {
        if (folderId && isDescendantFolder(folders, folderId, movedFolder)) return; // cycle
        if (movedFolder === folderId) return;
        void moveAssetFolder(movedFolder, folderId);
        return;
      }
      if (e.dataTransfer.files?.length) void ingest(e.dataTransfer.files, folderId);
    },
    [folders, ingest, moveAssetFolder, moveTypstAssetToFolder],
  );

  const onDragStartAsset = useCallback((e: React.DragEvent, asset: TypstAsset) => {
    e.dataTransfer.setData(ASSET_DRAG, asset.id);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const registerEl = useCallback((id: ID, el: HTMLDivElement | null) => {
    if (el) cardEls.current.set(id, el);
    else cardEls.current.delete(id);
  }, []);

  // Preview click-to-reveal: jump to the asset's folder, scroll it into
  // view and pulse its card.
  const reveal = typst?.reveal ?? null;
  useEffect(() => {
    if (!reveal) return;
    const asset = assets.find((a) => a.id === reveal.id);
    if (!asset) return;
    setSelectedFolder(asset.folderId ?? null);
    setFlashId(reveal.id);
    const raf = requestAnimationFrame(() => {
      cardEls.current.get(reveal.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    const timer = window.setTimeout(() => setFlashId(null), 3400);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(timer); };
    // Only a new click should re-trigger; the asset list refreshing must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

  const toggleExpanded = useCallback((id: ID) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const newFolder = useCallback((parentId: ID | null) => {
    void createAssetFolder('New folder', parentId)
      .then((f) => {
        if (parentId) setExpanded((prev) => new Set(prev).add(parentId));
        setSelectedFolder(f.id);
        setRenamingId(f.id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [createAssetFolder]);

  const commitRename = useCallback((id: ID, name: string) => {
    setRenamingId(null);
    const trimmed = name.trim();
    if (trimmed) void renameAssetFolder(id, trimmed);
  }, [renameAssetFolder]);

  // Stable per-card handlers. Defined once for the whole grid so the memoized
  // cards actually skip re-rendering when the panel does.
  const openAsset = useCallback((a: TypstAsset) => setEditing(a), []);
  // Deleting an asset removes its bytes permanently, so confirm first.
  const removeAsset = useCallback((a: TypstAsset) => setPendingDeleteAsset(a), []);

  // Keep the open dialog in sync if the record changes underneath us (a
  // collaborator cropping the same image, say).
  const editingLive = editing ? assets.find((a) => a.id === editing.id) ?? null : null;

  // The report's rail is ~240px wide, so it stacks the tree above the grid;
  // the Assets Manager tab has the whole tab and puts them side by side.
  const wide = !typst;
  const rootCount = counts.get('') ?? 0;
  const acceptsRowDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(ASSET_DRAG) ||
    e.dataTransfer.types.includes(FOLDER_DRAG) ||
    e.dataTransfer.types.includes('Files');

  return (
    <div
      className="relative flex h-full flex-col bg-[hsl(var(--card))]"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(ASSET_DRAG) || e.dataTransfer.types.includes(FOLDER_DRAG)) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* Header */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[hsl(var(--border))] px-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
          Assets
        </span>
        <div className="flex-1" />
        <button
          onClick={() => newFolder(selectedFolder)}
          title="New folder here"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
        >
          <FolderPlus size={11} /> Folder
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          title="Add images to this folder"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
          Add
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.ttf,.otf,.woff,.woff2,.ttc"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void ingest(e.target.files, selectedFolder);
            e.target.value = '';
          }}
        />
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-1.5 border-b border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-2 py-1.5 text-[10px] text-[hsl(var(--status-red))]">
          <AlertTriangle size={11} className="mt-px shrink-0" />
          <span className="whitespace-pre-wrap break-words">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto shrink-0 opacity-70 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      <div className={`min-h-0 flex-1 ${wide ? 'flex' : 'flex flex-col'} overflow-hidden`}>
        {/* Folder tree */}
        <div className={`atree shrink-0 overflow-y-auto p-2 ${
          wide
            ? 'w-64 border-r border-[hsl(var(--border))]'
            : 'max-h-[45%] border-b border-[hsl(var(--border))]'
        }`}>
          <div
            data-active={selectedFolder === null || undefined}
            onDragOver={(e) => { if (acceptsRowDrag(e)) { e.preventDefault(); e.stopPropagation(); } }}
            onDrop={(e) => onDropInto(e, null)}
            className={`flex w-full items-center rounded-lg border border-transparent hover:bg-[hsl(var(--accent))] ${
              selectedFolder === null ? 'bg-[hsl(var(--accent))]' : ''
            }`}
          >
            <span className="ml-0.5 inline-block w-[14px] shrink-0" aria-hidden />
            <button
              onClick={() => setSelectedFolder(null)}
              className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1.5 text-[11px]"
              title="Assets outside any folder"
            >
              <ImagePlus size={12} className="shrink-0 text-[hsl(var(--muted-foreground))]" />
              <span className="truncate font-medium">All assets</span>
              {rootCount > 0 && (
                <span className="ml-auto shrink-0 rounded-full bg-[hsl(var(--muted))] px-1.5 text-[9px] text-[hsl(var(--muted-foreground))]">
                  {rootCount}
                </span>
              )}
            </button>
          </div>
          {rootFolders.length > 0 && (
            <div className="atree-kids">
              {rootFolders.map((f) => (
                <FolderNode
                  key={f.id}
                  folder={f}
                  folders={folders}
                  selected={selectedFolder}
                  expanded={expanded}
                  counts={counts}
                  renamingId={renamingId}
                  onSelect={setSelectedFolder}
                  onToggle={toggleExpanded}
                  onStartRename={setRenamingId}
                  onCommitRename={commitRename}
                  onNewSubfolder={newFolder}
                  onDeleteFolder={setPendingDelete}
                  onDropInto={onDropInto}
                />
              ))}
            </div>
          )}
          {rootFolders.length === 0 && (
            <p className="mt-1 px-1 text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">
              Group screenshots by report section: one folder per finding, images inside.
            </p>
          )}
        </div>

        {/* Contents of the selected folder */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {trail.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">
              <button onClick={() => setSelectedFolder(null)} className="rounded px-1 py-0.5 hover:bg-[hsl(var(--accent))]">
                Assets
              </button>
              {trail.map((f) => (
                <span key={f.id} className="flex items-center gap-0.5">
                  <ChevronRight size={9} />
                  <button
                    onClick={() => setSelectedFolder(f.id)}
                    className={`rounded px-1 py-0.5 hover:bg-[hsl(var(--accent))] ${
                      f.id === selectedFolder ? 'text-[hsl(var(--foreground))]' : ''
                    }`}
                  >
                    {f.name}
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Images */}
          <div className="mb-1 flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
            <ImagePlus size={10} /> Images
          </div>
          {images.length > 0 ? (
            <div
              className={`mb-3 grid gap-1.5 ${wide ? '' : 'grid-cols-2'}`}
              style={wide ? { gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' } : undefined}
            >
              {images.map((a) => (
                <ImageCard
                  key={a.id}
                  asset={a}
                  placedIn={typst?.placements.get(assetPath(a)) ?? null}
                  flash={flashId === a.id}
                  onOpen={openAsset}
                  onDelete={removeAsset}
                  onInsert={typst?.onInsert}
                  onDragStartAsset={onDragStartAsset}
                  registerEl={registerEl}
                />
              ))}
            </div>
          ) : (
            <p className="mb-3 text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">
              {selectedFolder
                ? 'No images in this folder. Drop screenshots here, or drag cards onto a folder in the tree.'
                : "Drop screenshots here. You'll get a window to crop the image and redact anything sensitive."}
            </p>
          )}

        </div>
      </div>

      {/* Drop overlay */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10">
          <span className="rounded bg-[hsl(var(--card))] px-2 py-1 text-[10px] font-semibold uppercase tracking-widest">
            Drop to add{trail.length > 0 ? ` to "${trail[trail.length - 1]!.name}"` : ''}
          </span>
        </div>
      )}

      {pendingDeleteAsset && (
        <Portal>
          <ConfirmDialog
            title="Delete asset"
            message={`Delete "${pendingDeleteAsset.filename}"? This permanently removes the file and cannot be undone. Any document that references it will lose the image.`}
            confirmLabel="Delete"
            destructive
            onCancel={() => setPendingDeleteAsset(null)}
            onConfirm={() => {
              const a = pendingDeleteAsset;
              setPendingDeleteAsset(null);
              void deleteTypstAsset(a.id);
            }}
          />
        </Portal>
      )}

      {pendingDelete && (
        <Portal>
          <ConfirmDialog
            title="Delete folder"
            message={`Delete "${pendingDelete.name}"? Its subfolders and assets move up one level; no files are deleted.`}
            confirmLabel="Delete folder"
            destructive
            onCancel={() => setPendingDelete(null)}
            onConfirm={() => {
              const f = pendingDelete;
              setPendingDelete(null);
              if (selectedFolder === f.id) setSelectedFolder(f.parentId ?? null);
              void deleteAssetFolder(f.id);
            }}
          />
        </Portal>
      )}

      {editingLive && (typst ? (
        <Portal>
          {/* No fallback chrome: the dialog is a portal sheet, and a spinner
              behind the panel for the length of one chunk fetch would read as
              a glitch rather than as progress. */}
          <Suspense fallback={null}>
            <PlaceScreenshotDialog
              asset={editingLive}
              source={typst.source}
              onApply={(crop, blurs, slot, heightPt) => {
                typst.onPlace(editingLive, crop, blurs, slot, assetPath(editingLive), heightPt);
                setEditing(null);
              }}
              onUnplace={(crop, blurs, slot) => {
                typst.onPlace(editingLive, crop, blurs, slot, null, null);
                setEditing(null);
              }}
              onAddSlot={typst.onAddSlot}
              onRename={(stem) => typst.onRename(editingLive, stem)}
              onClose={() => setEditing(null)}
            />
          </Suspense>
        </Portal>
      ) : (
        <Portal>
          <ImageEditorDialog
            asset={editingLive}
            onApply={(crop, blurs) => {
              void setTypstAssetCrop(editingLive.id, crop, blurs);
              setEditing(null);
            }}
            onRename={(stem) => {
              void renameTypstAsset(editingLive.id, stem)
                .catch((e) => setError(e instanceof Error ? e.message : String(e)));
            }}
            onClose={() => setEditing(null)}
          />
        </Portal>
      ))}
    </div>
  );
});
