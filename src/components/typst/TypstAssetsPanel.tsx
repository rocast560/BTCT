// ─────────────────────────────────────────────────────────────────────────
// Assets rail for the Typst tab: drop screenshots and fonts here.
//
// Assets live in a folder hierarchy (report section → finding → images, or
// whatever shape the engagement wants). Folders are organizational only:
// an image keeps its flat `/assets/<name>` path in the compiler's virtual
// filesystem wherever it sits, so re-organizing never breaks the document.
// The tree mirrors the sidebar's page tree (chevrons + FolderPalette-style
// guide lines, drawn by glass.css on the `.atree-*` classes).
//
// Images become files under /assets, referenced as `#image("/assets/<name>")`.
// Clicking a thumbnail opens the crop editor; the crop is applied when the
// document renders, so the thumbnails deliberately show the *cropped* result.
// Fonts are installed into the compiler at init and used by name.
// ─────────────────────────────────────────────────────────────────────────

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ChevronRight, Crop, EyeOff, FileType, Folder, FolderPlus, ImagePlus,
  Loader2, MapPin, Maximize2, Minimize2, PanelRightClose, Pencil, Plus, Trash2, Type, Upload,
} from 'lucide-react';
import { useAppStore } from '@/stores';
import type { AssetFolder, BlurRegion, CropRect, ID, TypstAsset, TypstAssetKind } from '@/types';
import { blursKey, hasBlurs } from '@/lib/blur-math';
import { assetsInFolder, childFolders, folderTrail, isDescendantFolder } from '@/lib/asset-folders';
import { ASSET_DIR, assetPath, isFullFrame, resolveAssetBytes } from '@/lib/typst-assets';
import { ENCODABLE_FORMATS, formatFromFilename, mimeForFormat } from '@/lib/image-format';
import {
  ensureHelper,
  findScreenshotSlots,
  newSlotSnippet,
  retargetAssetPath,
  setSlotHeight,
  setSlotPath,
  type ScreenshotSlot,
} from '@/lib/typst-placeholders';
import { insertAtTypstCursor } from './TypstEditor';
import { PlaceScreenshotDialog } from './PlaceScreenshotDialog';
import { Portal } from '@/components/ui/Portal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

const FONT_EXTS = ['.ttf', '.otf', '.woff', '.woff2', '.ttc'];

/** Drag payload types for moving things between folders. */
const ASSET_DRAG = 'application/x-btct-asset';
const FOLDER_DRAG = 'application/x-btct-asset-folder';

/** How long the source must be idle before the figure slots are re-scanned. */
const SLOT_SCAN_DEBOUNCE_MS = 300;

/**
 * Trailing-edge debounce.
 *
 * The Typst source changes on every keystroke, but the slot scan it feeds is
 * only used to label thumbnails: it does not need to be frame-accurate.
 * Debouncing keeps a fast typist from re-parsing the whole document (and
 * re-rendering the thumbnail grid) ten times a second.
 */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** Route a dropped file to the right asset kind by extension. */
function kindForFile(file: File): TypstAssetKind | null {
  const name = file.name.toLowerCase();
  if (FONT_EXTS.some((e) => name.endsWith(e))) return 'font';
  if (file.type.startsWith('image/')) return 'image';
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(name)) return 'image';
  return null;
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

// Memoized: the panel re-renders whenever the Typst source changes (i.e. on
// every keystroke), but a thumbnail only actually changes when its asset
// record or its figure assignment does. Without this, typing re-renders every
// card and its <img> in the grid.
const ImageCard = memo(function ImageCard({
  asset,
  placedIn,
  flash,
  onOpen,
  onDelete,
  onDragStartAsset,
  registerEl,
}: {
  asset: TypstAsset;
  /** Caption of the figure this image currently fills, if any. */
  placedIn: string | null;
  /** Pulse-highlight this card (preview click-to-reveal landed on it). */
  flash: boolean;
  // Take the asset as an argument rather than closing over it, so the parent
  // can pass one stable callback instead of minting a new closure per card on
  // every render, which would defeat the memo above entirely.
  onOpen: (asset: TypstAsset) => void;
  onDelete: (asset: TypstAsset) => void;
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
        title={placedIn ? `Placed in "${placedIn}": click to re-crop or move` : `Crop and place ${asset.filename}`}
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

const FontRow = memo(function FontRow({
  asset,
  onInsert,
  onDelete,
  onDragStartAsset,
}: {
  asset: TypstAsset;
  onInsert: (asset: TypstAsset) => void;
  onDelete: (asset: TypstAsset) => void;
  onDragStartAsset: (e: React.DragEvent, asset: TypstAsset) => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStartAsset(e, asset)}
      className="group flex items-center gap-1.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.3)] px-2 py-1.5"
    >
      <Type size={12} className="shrink-0 text-[hsl(var(--status-purple))]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] text-[hsl(var(--foreground))]" title={asset.filename}>
          {asset.fontFamily || asset.filename}
        </div>
        {asset.fontFamily && (
          <div className="truncate font-mono text-[9px] text-[hsl(var(--muted-foreground))]">
            {asset.filename}
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={() => onInsert(asset)}
          title="Insert #set text(font: …) at the cursor"
          disabled={!asset.fontFamily}
          className="rounded p-1 hover:bg-[hsl(var(--accent))] disabled:opacity-30"
        >
          <Plus size={11} />
        </button>
        <button
          onClick={() => onDelete(asset)}
          title="Delete font"
          className="rounded p-1 hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--status-red))]"
        >
          <Trash2 size={11} />
        </button>
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

export const TypstAssetsPanel = memo(function TypstAssetsPanel({
  source,
  onSourceChange,
  fullscreen,
  onToggleFullscreen,
  onHide,
  reveal,
  standalone = false,
}: {
  /** Live Typst source: the figure slots are read out of it. */
  source: string;
  /** Apply a rewritten source through the collaborative Y.Text. */
  onSourceChange: (next: string) => void;
  /** Whether the panel currently covers the whole Typst tab. */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Collapse the panel entirely (the header's Assets button re-opens it). */
  onHide: () => void;
  /** Click-to-reveal from the preview: select + flash this asset. */
  reveal?: { id: ID; nonce: number } | null;
  /**
   * Standalone Assets Manager mode (its own tab, opened while taking notes):
   * always the wide two-column layout, no fullscreen/hide buttons, and the
   * image editor opens in crop+blur-only mode (no Typst figure placement).
   * Shares the same asset + folder state as the report.
   */
  standalone?: boolean;
}) {
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
  const [placing, setPlacing] = useState<TypstAsset | null>(null);
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
  const fonts = useMemo(
    () => assetsInFolder(live.filter((a) => a.kind === 'font'), selectedFolder),
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

  // Which figure (if any) each image currently fills, keyed by asset path.
  // Scanned off a debounced copy of the source: these labels are cosmetic, so
  // they can lag a keystroke rather than re-parsing the document on each one.
  const settledSource = useDebounced(source, SLOT_SCAN_DEBOUNCE_MS);
  const slots = useMemo(() => findScreenshotSlots(settledSource), [settledSource]);
  const captionByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of slots) {
      if (s.path) map.set(s.path, s.caption ?? `figure on line ${s.line}`);
    }
    return map;
  }, [slots]);

  const ingest = useCallback(
    async (files: FileList | File[], folderId: ID | null) => {
      const list = [...files];
      if (!list.length) return;
      setBusy(true);
      setError(null);
      const failures: string[] = [];
      let firstImage: TypstAsset | null = null;
      // Sequential rather than parallel: filename de-duplication reads the
      // current asset list, so two concurrent uploads of `shot.png` would
      // both see the name as free and collide in the virtual FS.
      for (const file of list) {
        const kind = kindForFile(file);
        if (!kind) {
          failures.push(`${file.name}: unsupported file type`);
          continue;
        }
        try {
          const created = await addTypstAsset(file, kind, folderId);
          if (kind === 'image' && !firstImage) firstImage = created;
        } catch (e) {
          failures.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setBusy(false);
      if (failures.length) setError(failures.join('\n'));
      // Drop → immediately offer crop + placement, which is the whole point
      // of dropping a screenshot in. Only for the first of a batch, so
      // dragging in ten files doesn't open ten dialogs.
      if (firstImage) setPlacing(firstImage);
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
  // cards actually skip re-rendering when the source changes.
  const openAsset = useCallback((a: TypstAsset) => setPlacing(a), []);
  // Deleting an asset removes its bytes permanently, so confirm first.
  const removeAsset = useCallback((a: TypstAsset) => setPendingDeleteAsset(a), []);

  const insertSnippet = useCallback((text: string) => {
    if (!insertAtTypstCursor(text)) {
      // Code pane hidden: put it on the clipboard so the action isn't a
      // dead end.
      void navigator.clipboard?.writeText(text);
      setError('Code editor is hidden: snippet copied to the clipboard instead.');
    }
  }, []);

  const insertFont = useCallback(
    (a: TypstAsset) => insertSnippet(`#set text(font: "${a.fontFamily}")\n`),
    [insertSnippet],
  );

  /**
   * Commit a crop and (optionally) an assignment to a figure slot.
   *
   * Order matters: the helper definition is upgraded/inserted *first*, then
   * the slots are re-scanned against that new source before rewriting one.
   * Editing the slot using offsets measured against the pre-upgrade source
   * would splice into the wrong position once the helper shifted everything
   * below it.
   */
  const applyPlacement = useCallback(
    (
      crop: CropRect | null,
      blurs: BlurRegion[] | null,
      slot: ScreenshotSlot | null,
      path: string | null,
      heightPt: number | null,
    ) => {
      if (!placing) return;
      void setTypstAssetCrop(placing.id, crop, blurs);

      if (slot) {
        const ensured = ensureHelper(source);
        let next = ensured.source;

        // Each rewrite shifts the offsets of everything after it, so re-scan
        // between edits and re-find the slot by its document order.
        const withHeight = (() => {
          if (heightPt === null) return next;
          const target = findScreenshotSlots(next)[slot.index];
          return target ? setSlotHeight(next, target, heightPt) : next;
        })();
        next = withHeight;

        const target = findScreenshotSlots(next)[slot.index];
        if (target) next = setSlotPath(next, target, path);

        if (next !== source) onSourceChange(next);
      }
      setPlacing(null);
    },
    [placing, setTypstAssetCrop, source, onSourceChange],
  );

  /**
   * Rename an asset and repoint the document at its new path in one go.
   *
   * The record is renamed first so the new filename is authoritative, then
   * every `"/assets/<old>"` literal in the source is rewritten. Doing it in
   * the other order would leave a window where the document referenced a
   * path the virtual filesystem no longer served.
   */
  const renameAsset = useCallback(
    (stem: string) => {
      if (!placing) return;
      const oldPath = assetPath(placing);
      void renameTypstAsset(placing.id, stem)
        .then((filename) => {
          const newPath = `${ASSET_DIR}/${filename}`;
          if (newPath === oldPath) return;
          const next = retargetAssetPath(source, oldPath, newPath);
          if (next !== source) onSourceChange(next);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    },
    [placing, renameTypstAsset, source, onSourceChange],
  );

  const addSlot = useCallback(
    (caption: string) => {
      const ensured = ensureHelper(source);
      const snippet = newSlotSnippet(caption);
      // Append at the end of the document: a predictable spot the picker
      // then scrolls to, rather than wherever a stale caret happens to be.
      const base = ensured.source.endsWith('\n') ? ensured.source : `${ensured.source}\n`;
      onSourceChange(`${base}\n${snippet}`);
    },
    [source, onSourceChange],
  );

  // Keep the open dialog in sync if the record changes underneath us (a
  // collaborator cropping the same image, say).
  const placingLive = placing ? assets.find((a) => a.id === placing.id) ?? null : null;

  // Standalone always uses the wide (side-by-side) layout of the full-tab mode.
  const wide = fullscreen || standalone;
  const rootCount = counts.get('') ?? 0;
  const acceptsRowDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(ASSET_DRAG) ||
    e.dataTransfer.types.includes(FOLDER_DRAG) ||
    e.dataTransfer.types.includes('Files');

  return (
    <div
      className="relative flex h-full flex-col border-l border-[hsl(var(--border))] bg-[hsl(var(--card))]"
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
          title="Add images or fonts to this folder"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
          Add
        </button>
        {!standalone && (
          <>
            <button
              onClick={onToggleFullscreen}
              title={fullscreen ? 'Exit full screen' : 'Expand the asset browser over the whole tab'}
              className="rounded p-1 hover:bg-[hsl(var(--accent))]"
            >
              {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
            <button
              onClick={onHide}
              title="Hide the assets panel"
              className="rounded p-1 hover:bg-[hsl(var(--accent))]"
            >
              <PanelRightClose size={12} />
            </button>
          </>
        )}
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
              <ImagePlus size={12} className="shrink-0 text-[hsl(var(--status-blue))]" />
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
                  placedIn={captionByPath.get(assetPath(a)) ?? null}
                  flash={flashId === a.id}
                  onOpen={openAsset}
                  onDelete={removeAsset}
                  onDragStartAsset={onDragStartAsset}
                  registerEl={registerEl}
                />
              ))}
            </div>
          ) : (
            <p className="mb-3 text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">
              {selectedFolder
                ? 'No images in this folder. Drop screenshots here, or drag cards onto a folder in the tree.'
                : "Drop screenshots here. You'll get a window to crop the image and choose which figure it goes into."}
            </p>
          )}

          {/* Fonts */}
          <div className="mb-1 flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
            <FileType size={10} /> Fonts
          </div>
          {fonts.length > 0 ? (
            <div className={`flex flex-col gap-1 ${wide ? 'max-w-md' : ''}`}>
              {fonts.map((a) => (
                <FontRow key={a.id} asset={a} onInsert={insertFont} onDelete={removeAsset} onDragStartAsset={onDragStartAsset} />
              ))}
            </div>
          ) : (
            <p className="text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">
              Drop .ttf / .otf / .woff files here to use them in the document.
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

      {placingLive && (
        <Portal>
          <PlaceScreenshotDialog
            asset={placingLive}
            source={source}
            hidePlacement={standalone}
            onApply={(crop, blurs, slot, heightPt) =>
              applyPlacement(crop, blurs, slot, assetPath(placingLive), heightPt)}
            onUnplace={(crop, blurs, slot) => applyPlacement(crop, blurs, slot, null, null)}
            onAddSlot={addSlot}
            onRename={renameAsset}
            onClose={() => setPlacing(null)}
          />
        </Portal>
      )}
    </div>
  );
});
