// ─────────────────────────────────────────────────────────────────────────
// Assets rail for the Typst tab — drop screenshots and fonts here.
//
// Images become files in the compiler's virtual filesystem under /assets,
// referenced as `#image("/assets/<name>")`. Clicking a thumbnail opens the
// crop editor; the crop is applied when the document renders, so the panel's
// thumbnails deliberately show the *cropped* result — what you see here is
// what lands in the PDF.
//
// Fonts are installed into the compiler at init and used by name, e.g.
// `#set text(font: "Inter")`.
// ─────────────────────────────────────────────────────────────────────────

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Crop, FileType, ImagePlus, Loader2, MapPin, Plus, Trash2, Type, Upload,
} from 'lucide-react';
import { useAppStore } from '@/stores';
import type { CropRect, TypstAsset, TypstAssetKind } from '@/types';
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

const FONT_EXTS = ['.ttf', '.otf', '.woff', '.woff2', '.ttc'];

/** How long the source must be idle before the figure slots are re-scanned. */
const SLOT_SCAN_DEBOUNCE_MS = 300;

/**
 * Trailing-edge debounce.
 *
 * The Typst source changes on every keystroke, but the slot scan it feeds is
 * only used to label thumbnails — it does not need to be frame-accurate.
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
  // Depend on the crop *value*, not identity, so a re-render with an equal
  // rect doesn't rebuild the blob.
  const cropKey = asset.crop
    ? `${asset.crop.x},${asset.crop.y},${asset.crop.w},${asset.crop.h}`
    : '';

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
  }, [asset.id, asset.kind, asset.mime, asset.filename, cropKey]);

  return { url, error };
}

// Memoized: the panel re-renders whenever the Typst source changes (i.e. on
// every keystroke), but a thumbnail only actually changes when its asset
// record or its figure assignment does. Without this, typing re-renders every
// card and its <img> in the grid.
const ImageCard = memo(function ImageCard({
  asset,
  placedIn,
  onOpen,
  onDelete,
}: {
  asset: TypstAsset;
  /** Caption of the figure this image currently fills, if any. */
  placedIn: string | null;
  // Take the asset as an argument rather than closing over it, so the parent
  // can pass one stable callback instead of minting a new closure per card on
  // every render — which would defeat the memo above entirely.
  onOpen: (asset: TypstAsset) => void;
  onDelete: (asset: TypstAsset) => void;
}) {
  const { url, error } = useAssetPreview(asset);
  const cropped = !isFullFrame(asset.crop);

  return (
    <div className="group relative overflow-hidden rounded border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.3)]">
      <button
        onClick={() => onOpen(asset)}
        title={placedIn ? `Placed in "${placedIn}" — click to re-crop or move` : `Crop and place ${asset.filename}`}
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
        title={placedIn ? `${assetPath(asset)} — in "${placedIn}"` : assetPath(asset)}
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
}: {
  asset: TypstAsset;
  onInsert: (asset: TypstAsset) => void;
  onDelete: (asset: TypstAsset) => void;
}) {
  return (
    <div className="group flex items-center gap-1.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.3)] px-2 py-1.5">
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

export const TypstAssetsPanel = memo(function TypstAssetsPanel({
  source,
  onSourceChange,
}: {
  /** Live Typst source — the figure slots are read out of it. */
  source: string;
  /** Apply a rewritten source through the collaborative Y.Text. */
  onSourceChange: (next: string) => void;
}) {
  const assets = useAppStore((s) => s.typstAssets);
  const addTypstAsset = useAppStore((s) => s.addTypstAsset);
  const deleteTypstAsset = useAppStore((s) => s.deleteTypstAsset);
  const setTypstAssetCrop = useAppStore((s) => s.setTypstAssetCrop);
  const renameTypstAsset = useAppStore((s) => s.renameTypstAsset);

  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState<TypstAsset | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const images = useMemo(() => assets.filter((a) => a.kind === 'image'), [assets]);
  const fonts = useMemo(() => assets.filter((a) => a.kind === 'font'), [assets]);

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
    async (files: FileList | File[]) => {
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
          const created = await addTypstAsset(file, kind);
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

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer?.files?.length) void ingest(e.dataTransfer.files);
    },
    [ingest],
  );

  // Stable per-card handlers. Defined once for the whole grid so the memoized
  // cards actually skip re-rendering when the source changes.
  const openAsset = useCallback((a: TypstAsset) => setPlacing(a), []);
  const removeAsset = useCallback(
    (a: TypstAsset) => { void deleteTypstAsset(a.id); },
    [deleteTypstAsset],
  );

  const insertSnippet = useCallback((text: string) => {
    if (!insertAtTypstCursor(text)) {
      // Code pane hidden — put it on the clipboard so the action isn't a
      // dead end.
      void navigator.clipboard?.writeText(text);
      setError('Code editor is hidden — snippet copied to the clipboard instead.');
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
      slot: ScreenshotSlot | null,
      path: string | null,
      heightPt: number | null,
    ) => {
      if (!placing) return;
      void setTypstAssetCrop(placing.id, crop);

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
      // Append at the end of the document — a predictable spot the picker
      // then scrolls to, rather than wherever a stale caret happens to be.
      const base = ensured.source.endsWith('\n') ? ensured.source : `${ensured.source}\n`;
      onSourceChange(`${base}\n${snippet}`);
    },
    [source, onSourceChange],
  );

  // Keep the open dialog in sync if the record changes underneath us (a
  // collaborator cropping the same image, say).
  const placingLive = placing ? assets.find((a) => a.id === placing.id) ?? null : null;

  return (
    <div
      className="relative flex h-full flex-col border-l border-[hsl(var(--border))] bg-[hsl(var(--card))]"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* Header */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-[hsl(var(--border))] px-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
          Assets
        </span>
        <button
          onClick={() => fileInputRef.current?.click()}
          title="Add images or fonts"
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
            if (e.target.files) void ingest(e.target.files);
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

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {/* Images */}
        <div className="mb-1 flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
          <ImagePlus size={10} /> Images
        </div>
        {images.length > 0 ? (
          <div className="mb-3 grid grid-cols-2 gap-1.5">
            {images.map((a) => (
              <ImageCard
                key={a.id}
                asset={a}
                placedIn={captionByPath.get(assetPath(a)) ?? null}
                onOpen={openAsset}
                onDelete={removeAsset}
              />
            ))}
          </div>
        ) : (
          <p className="mb-3 text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">
            Drop screenshots here. You'll get a window to crop the image and
            choose which figure it goes into.
          </p>
        )}

        {/* Fonts */}
        <div className="mb-1 flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
          <FileType size={10} /> Fonts
        </div>
        {fonts.length > 0 ? (
          <div className="flex flex-col gap-1">
            {fonts.map((a) => (
              <FontRow key={a.id} asset={a} onInsert={insertFont} onDelete={removeAsset} />
            ))}
          </div>
        ) : (
          <p className="text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">
            Drop .ttf / .otf / .woff files here to use them in the document.
          </p>
        )}
      </div>

      {/* Drop overlay */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10">
          <span className="rounded bg-[hsl(var(--card))] px-2 py-1 text-[10px] font-semibold uppercase tracking-widest">
            Drop to add
          </span>
        </div>
      )}

      {placingLive && (
        <PlaceScreenshotDialog
          asset={placingLive}
          source={source}
          onApply={(crop, slot, heightPt) =>
            applyPlacement(crop, slot, assetPath(placingLive), heightPt)}
          onUnplace={(crop, slot) => applyPlacement(crop, slot, null, null)}
          onAddSlot={addSlot}
          onRename={renameAsset}
          onClose={() => setPlacing(null)}
        />
      )}
    </div>
  );
});
