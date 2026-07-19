// ─────────────────────────────────────────────────────────────────────────
// Crop-and-place window for a Typst screenshot.
//
// The left half is a **viewport**, not a free crop: the frame is drawn to the
// figure box's real proportions (derived from the document's page setup and
// the slot's height), and the image is panned and scaled behind it. What sits
// inside the frame is exactly what the figure renders — the crop rect carries
// the box's aspect ratio, so the bytes drop into the PDF with no letterboxing
// and no distortion. Scale the image past the border and it's clipped there;
// scale it smaller and the placeholder grey shows through.
//
// The right half lists the document's figure slots. An image goes into a
// declared `#image-placeholder(…)` slot rather than wherever the caret
// happens to be, so captions and numbering stay consistent.
//
// Nothing here touches the uploaded bytes: both the crop and the placement
// are reversible.
// ─────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Crop, ImageOff, Loader2, Maximize2, MapPin, Minimize2, Pencil,
  Plus, RotateCcw, Wand2, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { CropRect, TypstAsset } from '@/types';
import { detectContentBounds, fetchAssetBytes, assetPath } from '@/lib/typst-assets';
import {
  constrainToAspect,
  fitCropToBox,
  isFullFrame,
  zoomCrop,
  zoomPercent,
} from '@/lib/crop-math';
import {
  DEFAULT_FIGURE_HEIGHT_PT,
  figureBox,
  formatLength,
} from '@/lib/typst-geometry';
import { findScreenshotSlots, inspectHelper, type ScreenshotSlot } from '@/lib/typst-placeholders';
import { FigureViewport } from './FigureViewport';

/** Height presets, chosen so the resulting box shapes span the useful range. */
const HEIGHT_PRESETS: { label: string; inches: number }[] = [
  { label: 'Banner', inches: 1.6 },
  { label: 'Standard', inches: 2.2 },
  { label: 'Wide 16:9', inches: 3.4 },
  { label: 'Large', inches: 4.5 },
  { label: 'Tall', inches: 6.0 },
];

/**
 * Editable file name.
 *
 * Only the stem is editable — the extension is shown but fixed. Typst picks
 * its image decoder from the extension and the stored bytes are normalized to
 * match it, so letting someone rename `shot.png` to `shot.jpg` would
 * reintroduce a decode failure at compile time.
 */
function AssetNameField({
  asset,
  onRename,
}: {
  asset: TypstAsset;
  onRename: (stem: string) => void;
}) {
  const dot = asset.filename.lastIndexOf('.');
  const currentStem = dot > 0 ? asset.filename.slice(0, dot) : asset.filename;
  const ext = dot > 0 ? asset.filename.slice(dot) : '';

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentStem);

  useEffect(() => { if (!editing) setDraft(currentStem); }, [currentStem, editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== currentStem) onRename(next);
    else setDraft(currentStem);
  };

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        title="Click to rename — references in the document are updated automatically"
        className="group flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] hover:bg-[hsl(var(--accent))]"
      >
        <span className="truncate">{asset.filename}</span>
        <Pencil size={10} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
      </button>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-0.5 font-mono text-[11px]">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // Keep Enter/Escape from reaching the dialog's own shortcuts, which
          // would place the image or close the window mid-rename.
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); setDraft(currentStem); setEditing(false); }
        }}
        className="min-w-0 max-w-[22rem] flex-1 rounded border border-[hsl(var(--primary))] bg-[hsl(var(--background))] px-1.5 py-0.5 outline-none"
      />
      <span className="shrink-0 text-[hsl(var(--muted-foreground))]">{ext}</span>
    </span>
  );
}

export function PlaceScreenshotDialog({
  asset,
  source,
  onApply,
  onUnplace,
  onAddSlot,
  onRename,
  onClose,
}: {
  asset: TypstAsset;
  /** Current Typst source — the figure slots and page geometry come from it. */
  source: string;
  /**
   * Commit. `slot` is null when only the crop changed. `heightPt` is set when
   * the figure's height was adjusted and needs writing onto the slot.
   */
  onApply: (crop: CropRect | null, slot: ScreenshotSlot | null, heightPt: number | null) => void;
  /** Clear the image out of `slot`, leaving the empty placeholder behind. */
  onUnplace: (crop: CropRect | null, slot: ScreenshotSlot) => void;
  /** Append a new empty figure slot to the document and return to the picker. */
  onAddSlot: (caption: string) => void;
  /** Rename the asset's file stem, repointing any document references. */
  onRename: (stem: string) => void;
  onClose: () => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(
    asset.width && asset.height ? { w: asset.width, h: asset.height } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const [newCaption, setNewCaption] = useState('');
  const [addingSlot, setAddingSlot] = useState(false);

  const path = assetPath(asset);
  const slots = useMemo(() => findScreenshotSlots(source), [source]);
  const helper = useMemo(() => inspectHelper(source), [source]);

  const currentSlotIndex = useMemo(
    () => slots.findIndex((s) => s.path === path),
    [slots, path],
  );

  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    if (selected !== null) return;
    if (currentSlotIndex !== -1) { setSelected(currentSlotIndex); return; }
    const firstEmpty = slots.findIndex((s) => s.path === null);
    if (firstEmpty !== -1) setSelected(firstEmpty);
  }, [slots, currentSlotIndex, selected]);

  const targetSlot = selected !== null ? slots[selected] ?? null : null;

  // ── figure box ─────────────────────────────────────────────────────────
  // Height starts from the target slot's own `height:` argument so the frame
  // matches that specific figure, not a global default.
  const [heightPt, setHeightPt] = useState<number>(
    targetSlot?.heightPt ?? DEFAULT_FIGURE_HEIGHT_PT,
  );
  const heightTouched = useRef(false);

  // Adopt the newly-selected slot's height, unless the user has deliberately
  // set one in this session (in which case they're applying it to the slot).
  useEffect(() => {
    if (heightTouched.current) return;
    setHeightPt(targetSlot?.heightPt ?? DEFAULT_FIGURE_HEIGHT_PT);
  }, [targetSlot]);

  const box = useMemo(() => figureBox(source, heightPt), [source, heightPt]);

  const [crop, setCrop] = useState<CropRect | null>(asset.crop ?? null);

  // Load the bytes and, if the record didn't carry them, the real dimensions.
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setError(null);
    fetchAssetBytes(asset.id)
      .then((b) => {
        if (cancelled) return;
        setBytes(b);
        url = URL.createObjectURL(new Blob([b.slice().buffer as ArrayBuffer], { type: asset.mime }));
        setImgUrl(url);
        if (!asset.width || !asset.height) {
          const probe = new Image();
          probe.onload = () => {
            if (!cancelled) setNatural({ w: probe.naturalWidth, h: probe.naturalHeight });
          };
          probe.src = url;
        }
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [asset.id, asset.mime, asset.width, asset.height]);

  // First placement: fill the frame, centred.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !natural) return;
    seeded.current = true;
    if (asset.crop) {
      // An existing crop was stored against whatever box it was made for;
      // re-fit it to this one so the frame and the rect always agree.
      setCrop(constrainToAspect(asset.crop, natural.w, natural.h, box.aspect));
    } else {
      setCrop(fitCropToBox(natural.w, natural.h, box.aspect, 'cover'));
    }
  }, [natural, asset.crop, box.aspect]);

  // Re-fit whenever the box shape changes (height control, different slot).
  const lastAspect = useRef(box.aspect);
  useEffect(() => {
    if (!natural || !crop) return;
    if (Math.abs(lastAspect.current - box.aspect) < 1e-9) return;
    lastAspect.current = box.aspect;
    setCrop(constrainToAspect(crop, natural.w, natural.h, box.aspect));
  }, [box.aspect, natural, crop]);

  const runAutoDetect = useCallback(
    async (data: Uint8Array, silent: boolean) => {
      if (!natural) return;
      setDetecting(true);
      try {
        const found = await detectContentBounds(data, asset.mime);
        if (found) {
          // Trim the borders, then re-frame that region to the box.
          setCrop(constrainToAspect(found, natural.w, natural.h, box.aspect));
          setAutoNote('Trimmed the border and re-framed to the figure.');
        } else if (!silent) {
          setAutoNote('No uniform border found to trim.');
        }
      } catch {
        if (!silent) setAutoNote('Auto-detect failed on this image.');
      } finally {
        setDetecting(false);
      }
    },
    [asset.mime, box.aspect, natural],
  );

  const fill = useCallback(() => {
    if (!natural) return;
    setCrop(fitCropToBox(natural.w, natural.h, box.aspect, 'cover'));
    setAutoNote(null);
  }, [natural, box.aspect]);

  const fitWhole = useCallback(() => {
    if (!natural) return;
    setCrop(fitCropToBox(natural.w, natural.h, box.aspect, 'contain'));
    setAutoNote(null);
  }, [natural, box.aspect]);

  const nudgeZoom = useCallback((factor: number) => {
    setCrop((c) => (c ? zoomCrop(c, factor) : c));
  }, []);

  const applyHeight = useCallback((pt: number) => {
    heightTouched.current = true;
    setHeightPt(Math.max(pt, 18)); // a quarter inch floor
  }, []);

  const cropValue = crop && !isFullFrame(crop) ? crop : crop;
  const heightChanged = targetSlot
    ? Math.abs((targetSlot.heightPt ?? DEFAULT_FIGURE_HEIGHT_PT) - heightPt) > 0.5
    : heightTouched.current;

  const place = useCallback(() => {
    if (!targetSlot) return;
    onApply(cropValue, targetSlot, heightChanged ? heightPt : null);
  }, [onApply, cropValue, targetSlot, heightChanged, heightPt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (addingSlot) return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && targetSlot) place();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, place, targetSlot, addingSlot]);

  const submitNewSlot = () => {
    const caption = newCaption.trim();
    if (!caption) return;
    onAddSlot(caption);
    setNewCaption('');
    setAddingSlot(false);
    setSelected(slots.length);
  };

  const heightInches = heightPt / 72;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm motion-safe:animate-[fadeIn_120ms_ease-out]"
        onClick={onClose}
      />
      <div className="relative z-10 flex h-[min(92vh,900px)] w-[min(1600px,96vw)] flex-col overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-[0_24px_70px_-12px_rgba(0,0,0,0.7)] ring-1 ring-white/5 motion-safe:animate-[popIn_140ms_cubic-bezier(0.16,1,0.3,1)]">
        <style>{`
          @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
          @keyframes popIn {
            from { opacity: 0; transform: scale(0.97) translateY(6px) }
            to   { opacity: 1; transform: scale(1) translateY(0) }
          }
        `}</style>

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[hsl(var(--border))] px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Crop size={14} className="shrink-0 text-[hsl(var(--status-purple))]" />
            <span className="shrink-0 text-[11px] font-bold uppercase tracking-widest">
              Place screenshot
            </span>
            <span className="shrink-0 text-[hsl(var(--muted-foreground))]">—</span>
            <AssetNameField asset={asset} onRename={onRename} />
          </div>
          <button onClick={onClose} title="Close" className="rounded p-1 hover:bg-[hsl(var(--accent))]">
            <X size={14} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Viewport */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[hsl(var(--muted)/0.4)]">
            <div className="min-h-0 flex-1">
              {error ? (
                <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--status-red))]">
                  {error}
                </div>
              ) : !imgUrl || !crop ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
                  <Loader2 size={14} className="animate-spin" /> Loading image…
                </div>
              ) : (
                <FigureViewport
                  imageUrl={imgUrl}
                  crop={crop}
                  boxAspect={box.aspect}
                  onCropChange={(next) => { setCrop(next); setAutoNote(null); }}
                />
              )}
            </div>

            {/* Framing controls */}
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2">
              <button
                onClick={fill}
                title="Scale so the image fills the figure, cropping the overflow"
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
              >
                <Maximize2 size={12} /> Fill
              </button>
              <button
                onClick={fitWhole}
                title="Scale so the whole image is inside the figure"
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
              >
                <Minimize2 size={12} /> Fit all
              </button>
              <button
                onClick={() => bytes && void runAutoDetect(bytes, false)}
                disabled={!bytes || detecting || asset.mime === 'image/svg+xml'}
                title="Trim uniform borders, then re-frame"
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))] disabled:opacity-40"
              >
                {detecting ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                Auto
              </button>

              <div className="mx-1 h-4 w-px bg-[hsl(var(--border))]" />

              <button onClick={() => nudgeZoom(1.15)} title="Zoom out" className="rounded p-1 hover:bg-[hsl(var(--accent))]">
                <ZoomOut size={13} />
              </button>
              <span className="min-w-[46px] text-center font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
                {crop ? `${zoomPercent(crop)}%` : '—'}
              </span>
              <button onClick={() => nudgeZoom(1 / 1.15)} title="Zoom in" className="rounded p-1 hover:bg-[hsl(var(--accent))]">
                <ZoomIn size={13} />
              </button>

              <span className="ml-2 text-[10px] text-[hsl(var(--muted-foreground))]">
                drag to reposition · scroll to zoom
              </span>
            </div>
          </div>

          {/* Figure slot picker + height */}
          <div className="flex w-72 shrink-0 flex-col border-l border-[hsl(var(--border))]">
            <div className="flex items-center gap-1.5 border-b border-[hsl(var(--border))] px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
              <MapPin size={11} /> Figure location
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {slots.length === 0 ? (
                <p className="px-1 py-2 text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                  This document has no figure slots yet. Add one below — it
                  renders as a labelled placeholder box until an image is
                  assigned, so an unfilled figure is obvious in the PDF.
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {slots.map((slot, i) => {
                    const isSelected = selected === i;
                    const holdsThis = slot.path === path;
                    const occupied = slot.path !== null && !holdsThis;
                    return (
                      <button
                        key={`${slot.start}-${i}`}
                        onClick={() => { setSelected(i); heightTouched.current = false; }}
                        className={`flex flex-col items-start gap-0.5 rounded border px-2 py-1.5 text-left transition-colors ${
                          isSelected
                            ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10'
                            : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]'
                        }`}
                      >
                        <span className="flex w-full items-center gap-1">
                          <span className="truncate text-[11px] text-[hsl(var(--foreground))]">
                            {slot.caption ?? <em className="opacity-70">untitled figure</em>}
                          </span>
                          {holdsThis && (
                            <span className="ml-auto shrink-0 rounded bg-[hsl(var(--status-purple))] px-1 text-[8px] font-bold uppercase text-white">
                              here
                            </span>
                          )}
                        </span>
                        <span className="text-[9px] text-[hsl(var(--muted-foreground))]">
                          line {slot.line}
                          {occupied && ' — will replace current image'}
                          {slot.path === null && ' — empty'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="mt-2 border-t border-[hsl(var(--border))] pt-2">
                {addingSlot ? (
                  <div className="flex flex-col gap-1">
                    <input
                      autoFocus
                      value={newCaption}
                      onChange={(e) => setNewCaption(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') { e.preventDefault(); submitNewSlot(); }
                        if (e.key === 'Escape') { e.preventDefault(); setAddingSlot(false); }
                      }}
                      placeholder="Figure caption…"
                      className="w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-1.5 py-1 text-[11px] outline-none focus:border-[hsl(var(--primary))]"
                    />
                    <div className="flex gap-1">
                      <button
                        onClick={submitNewSlot}
                        disabled={!newCaption.trim()}
                        className="flex-1 rounded bg-[hsl(var(--primary))] px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-[hsl(var(--primary-foreground))] disabled:opacity-40"
                      >
                        Add
                      </button>
                      <button
                        onClick={() => setAddingSlot(false)}
                        className="rounded px-2 py-1 text-[9px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setAddingSlot(true)}
                    className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-[hsl(var(--border))] px-2 py-1.5 text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
                  >
                    <Plus size={11} /> New figure slot
                  </button>
                )}
              </div>

              {/* Figure size */}
              <div className="mt-3 border-t border-[hsl(var(--border))] pt-2">
                <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
                  Figure size
                </div>
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {HEIGHT_PRESETS.map((p) => {
                    const active = Math.abs(p.inches * 72 - heightPt) < 0.5;
                    return (
                      <button
                        key={p.label}
                        onClick={() => applyHeight(p.inches * 72)}
                        title={`${p.inches}in tall — ${(box.widthPt / (p.inches * 72)).toFixed(2)}:1`}
                        className={`rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wide transition-colors ${
                          active
                            ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 text-[hsl(var(--foreground))]'
                            : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="range"
                  min={0.8}
                  max={8}
                  step={0.05}
                  value={heightInches}
                  onChange={(e) => applyHeight(Number(e.target.value) * 72)}
                  className="w-full accent-[hsl(var(--primary))]"
                />
                <div className="mt-1 flex items-baseline justify-between font-mono text-[9px] text-[hsl(var(--muted-foreground))]">
                  <span>{formatLength(heightPt, 'in')} tall</span>
                  <span>{box.aspect.toFixed(2)}:1</span>
                </div>
                <div className="mt-0.5 font-mono text-[9px] text-[hsl(var(--muted-foreground))]">
                  {Math.round(box.widthPt)} × {Math.round(box.heightPt)} pt on the page
                </div>
                {heightChanged && targetSlot && (
                  <p className="mt-1 text-[9px] leading-relaxed text-[hsl(var(--status-purple))]">
                    Placing will set this figure's height to {formatLength(heightPt, 'in')}.
                  </p>
                )}
              </div>

              {slots.length > 0 && !helper.supportsPath && (
                <p className="mt-2 rounded bg-[hsl(var(--status-purple))]/10 px-2 py-1.5 text-[9px] leading-relaxed text-[hsl(var(--status-purple))]">
                  {helper.defined
                    ? 'Your image-placeholder helper will be upgraded to accept an image path. Your placeholder styling is preserved.'
                    : 'The image-placeholder helper will be added to the top of the document.'}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--border))] px-4 py-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
              {natural ? `source ${natural.w} × ${natural.h} px` : 'measuring…'}
            </span>
            {autoNote && (
              <span className="truncate text-[10px] text-[hsl(var(--status-purple))]">{autoNote}</span>
            )}
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => { seeded.current = false; setCrop(null); fill(); }}
              title="Reset the framing"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
            >
              <RotateCcw size={12} /> Reset
            </button>
            {currentSlotIndex !== -1 && (
              <button
                onClick={() => onUnplace(cropValue, slots[currentSlotIndex]!)}
                title="Remove this image from its figure (the empty slot stays)"
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide text-[hsl(var(--status-red))] hover:bg-[hsl(var(--accent))]"
              >
                <ImageOff size={12} /> Unplace
              </button>
            )}
            <div className="mx-1 h-4 w-px bg-[hsl(var(--border))]" />
            <button
              onClick={() => onApply(cropValue, null, null)}
              title="Save the framing without changing where the image sits"
              className="rounded-md px-2.5 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
            >
              Save framing
            </button>
            <button
              onClick={place}
              disabled={!targetSlot}
              title={targetSlot ? 'Place into the selected figure' : 'Select a figure location first'}
              className="rounded-md bg-[hsl(var(--primary))] px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-40"
            >
              Place in figure
            </button>
          </div>
        </div>

        {error && (
          <div className="flex shrink-0 items-center gap-1.5 border-t border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-4 py-1.5 text-[10px] text-[hsl(var(--status-red))]">
            <AlertTriangle size={11} /> {error}
          </div>
        )}
      </div>
    </div>
  );
}
