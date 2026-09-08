// ─────────────────────────────────────────────────────────────────────────
// Crop-and-redact window for a shared image asset.
//
// The frame is a **viewport**, not a free crop: it is drawn to a fixed shape
// and the image is panned and scaled behind it, so the stored `CropRect`
// always carries the frame's aspect ratio. The frame's shape is the image's
// own, so an untouched asset starts as the identity crop. Scale the image
// past the border and it is clipped there; scale it smaller and grey shows
// through, exactly as it will render in a note.
//
// Nothing here touches the uploaded bytes. Both the crop and the redaction
// rectangles are render-time metadata on the record, so either can be
// removed later and the original is always recoverable.
// ─────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Crop, EyeOff, Loader2, Maximize2, Minimize2, Pencil,
  RotateCcw, Wand2, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { BlurRegion, BlurStyle, CropRect, TypstAsset } from '@/types';
import {
  blursKey,
  effectiveStrength,
  effectiveStyle,
  MAX_STRENGTH,
  MIN_STRENGTH,
} from '@/lib/blur-math';
import { ENCODABLE_FORMATS, formatFromFilename } from '@/lib/image-format';
import {
  blurredPreviewBytes,
  detectContentBounds,
  fetchAssetBytes,
} from '@/lib/assets';
import {
  constrainToAspect,
  fitCropToBox,
  isFullFrame,
  zoomCrop,
  zoomPercent,
} from '@/lib/crop-math';
import { FigureViewport } from './FigureViewport';
import { useAuthStore } from '@/auth/auth-store';
import { useThemeStore } from '@/stores/theme-store';
import { resolveBlurStrengthPolicy, resolvePrefs } from '@/lib/editor-prefs';

/**
 * Frame shape when the asset has no recorded pixel size yet (the record is
 * written before the image is measured). 4:3 is a safe middle: the first
 * `fill` re-fits the crop against the real dimensions the moment they land.
 */
const FALLBACK_ASPECT = 4 / 3;

/**
 * Editable file name.
 *
 * Only the stem is editable: the extension is shown but fixed. It drives the
 * decoder choice and the byte normalization, so letting someone rename
 * `shot.png` to `shot.jpg` would reintroduce a decode failure on read.
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
        title="Click to rename: references in the document are updated automatically"
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

export function ImageEditorDialog({
  asset,
  onApply,
  onRename,
  onClose,
}: {
  asset: TypstAsset;
  /** Commit the framing and the redaction rectangles. */
  onApply: (crop: CropRect | null, blurs: BlurRegion[] | null) => void;
  /** Rename the asset's file stem. */
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

  // The frame takes the image's own shape, so an asset that has never been
  // cropped opens as the identity crop rather than an arbitrary letterbox.
  // A stored crop wins: re-opening the editor must show what is saved.
  const boxAspect = useMemo(() => {
    if (asset.crop && asset.crop.h > 0) {
      const w = (asset.width ?? 0) * asset.crop.w;
      const h = (asset.height ?? 0) * asset.crop.h;
      if (w > 0 && h > 0) return w / h;
    }
    if (asset.width && asset.height) return asset.width / asset.height;
    return FALLBACK_ASPECT;
  }, [asset.crop, asset.width, asset.height]);

  const [crop, setCrop] = useState<CropRect | null>(asset.crop ?? null);

  // ── blur (redaction) regions ───────────────────────────────────────────
  const [blurs, setBlurs] = useState<BlurRegion[]>(asset.blurs ?? []);
  const [blurMode, setBlurMode] = useState(false);
  // Formats a canvas can't re-encode (GIF, SVG) can't be blurred either.
  const canBlur = (() => {
    const f = formatFromFilename(asset.filename);
    return !!f && ENCODABLE_FORMATS.has(f);
  })();

  // The style/strength controls edit the selected region when there is one,
  // and otherwise set what the next drawn region gets. New regions start at
  // the account's default strength (or the admin's workspace default).
  const adminBlur = useThemeStore((s) => s.blurDefaults);
  const authUser = useAuthStore((s) => s.user);
  const defaultStrengths = useMemo(
    () => resolveBlurStrengthPolicy(adminBlur, resolvePrefs(authUser).blurDefaults),
    [adminBlur, authUser],
  );
  const [selectedBlur, setSelectedBlur] = useState<number | null>(null);
  const [blurStyle, setBlurStyle] = useState<BlurStyle>('gaussian');
  const [blurStrength, setBlurStrength] = useState(() => defaultStrengths.gaussian);

  const patchSelected = useCallback((patch: Partial<BlurRegion>) => {
    if (selectedBlur === null) return;
    setBlurs((b) => b.map((r, i) => (i === selectedBlur ? { ...r, ...patch } : r)));
  }, [selectedBlur]);

  const applyBlurStyle = useCallback((style: BlurStyle) => {
    setBlurStyle(style);
    // With no region selected the controls set up the NEXT region, so
    // switching style loads that style's default strength.
    if (selectedBlur === null) setBlurStrength(defaultStrengths[style]);
    patchSelected({ style });
  }, [patchSelected, selectedBlur, defaultStrengths]);

  const applyBlurStrength = useCallback((strength: number) => {
    setBlurStrength(strength);
    patchSelected({ strength });
  }, [patchSelected]);

  const addBlur = useCallback((r: BlurRegion) => {
    const region = { ...r, style: blurStyle, strength: blurStrength };
    setBlurs((b) => [...b, region]);
    // Select what was just drawn so the controls adjust it immediately.
    setSelectedBlur(blurs.length);
  }, [blurs.length, blurStyle, blurStrength]);

  const selectBlur = useCallback((i: number | null) => {
    setSelectedBlur(i);
    if (i === null) return;
    const r = blurs[i];
    if (r) {
      // Reflect the selected region in the controls.
      setBlurStyle(effectiveStyle(r));
      setBlurStrength(effectiveStrength(r));
    }
  }, [blurs]);

  const removeBlur = useCallback((i: number) => {
    setBlurs((b) => b.filter((_, j) => j !== i));
    setSelectedBlur((sel) =>
      sel === null ? null : sel === i ? null : sel > i ? sel - 1 : sel);
  }, []);

  const exitBlurMode = useCallback(() => {
    setBlurMode(false);
    setSelectedBlur(null);
  }, []);

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

  // Viewport image with the blur regions baked through the real pipeline,
  // so the frame previews exactly the bytes the compiler will receive. The
  // in-flight drag gets a cheap CSS preview inside FigureViewport instead;
  // this only re-bakes when a region is committed or removed.
  const [blurredUrl, setBlurredUrl] = useState<string | null>(null);
  const blursDep = blursKey(blurs);
  useEffect(() => {
    if (!bytes || blurs.length === 0 || !canBlur) {
      setBlurredUrl(null);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    // Debounced: dragging the strength slider changes the regions many times
    // a second, and each bake re-encodes the image at full resolution.
    const timer = setTimeout(() => {
      blurredPreviewBytes(bytes, asset.mime, blurs)
        .then((out) => {
          if (cancelled) return;
          url = URL.createObjectURL(
            new Blob([out.slice().buffer as ArrayBuffer], { type: 'image/png' }),
          );
          setBlurredUrl(url);
        })
        .catch(() => { if (!cancelled) setBlurredUrl(null); });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
    // Depend on the regions' value, not the array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, asset.mime, canBlur, blursDep]);

  // First placement: fill the frame, centred.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !natural) return;
    seeded.current = true;
    if (asset.crop) {
      // An existing crop was stored against whatever box it was made for;
      // re-fit it to this one so the frame and the rect always agree.
      setCrop(constrainToAspect(asset.crop, natural.w, natural.h, boxAspect));
    } else {
      setCrop(fitCropToBox(natural.w, natural.h, boxAspect, 'cover'));
    }
  }, [natural, asset.crop, boxAspect]);

  // Re-fit whenever the box shape changes (height control, different slot).
  const lastAspect = useRef(boxAspect);
  useEffect(() => {
    if (!natural || !crop) return;
    if (Math.abs(lastAspect.current - boxAspect) < 1e-9) return;
    lastAspect.current = boxAspect;
    setCrop(constrainToAspect(crop, natural.w, natural.h, boxAspect));
  }, [boxAspect, natural, crop]);

  const runAutoDetect = useCallback(
    async (data: Uint8Array, silent: boolean) => {
      if (!natural) return;
      setDetecting(true);
      try {
        const found = await detectContentBounds(data, asset.mime);
        if (found) {
          // Trim the borders, then re-frame that region to the box.
          setCrop(constrainToAspect(found, natural.w, natural.h, boxAspect));
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
    [asset.mime, boxAspect, natural],
  );

  const fill = useCallback(() => {
    if (!natural) return;
    setCrop(fitCropToBox(natural.w, natural.h, boxAspect, 'cover'));
    setAutoNote(null);
  }, [natural, boxAspect]);

  const fitWhole = useCallback(() => {
    if (!natural) return;
    setCrop(fitCropToBox(natural.w, natural.h, boxAspect, 'contain'));
    setAutoNote(null);
  }, [natural, boxAspect]);

  const nudgeZoom = useCallback((factor: number) => {
    setCrop((c) => (c ? zoomCrop(c, factor) : c));
  }, []);

  const cropValue = crop && !isFullFrame(crop) ? crop : crop;
  const blursValue = blurs.length > 0 ? blurs : null;
  const save = useCallback(() => {
    onApply(cropValue, blursValue);
  }, [onApply, cropValue, blursValue]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc steps out of blur-drawing before it closes the window.
        if (blurMode) { exitBlurMode(); return; }
        onClose();
      }
      if (e.key === 'Enter') save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, save, blurMode, exitBlurMode]);

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
              Edit image
            </span>
            <span className="shrink-0 text-[hsl(var(--muted-foreground))]">·</span>
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
                  imageUrl={blurredUrl ?? imgUrl}
                  crop={crop}
                  boxAspect={boxAspect}
                  onCropChange={(next) => { setCrop(next); setAutoNote(null); }}
                  blurMode={blurMode && canBlur}
                  blurs={blurs}
                  onAddBlur={addBlur}
                  onRemoveBlur={removeBlur}
                  selectedBlur={selectedBlur}
                  onSelectBlur={selectBlur}
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

              <button
                onClick={() => (blurMode ? exitBlurMode() : setBlurMode(true))}
                disabled={!canBlur}
                title={canBlur
                  ? 'Draw rectangles over sensitive content; they render blurred'
                  : 'This format cannot be blurred'}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide disabled:opacity-40 ${
                  blurMode
                    ? 'bg-[hsl(var(--status-purple))]/15 text-[hsl(var(--status-purple))]'
                    : 'hover:bg-[hsl(var(--accent))]'
                }`}
              >
                <EyeOff size={12} /> Blur{blurs.length > 0 ? ` (${blurs.length})` : ''}
              </button>

              {blurMode && (
                <>
                  {/* Style + strength: edit the selected region, or set what
                      the next drawn region gets. */}
                  <div className="flex overflow-hidden rounded border border-[hsl(var(--border))]">
                    {(['gaussian', 'pixelate'] as const).map((style) => (
                      <button
                        key={style}
                        onClick={() => applyBlurStyle(style)}
                        title={style === 'gaussian'
                          ? 'Smooth gaussian blur'
                          : 'Hard mosaic blocks'}
                        className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
                          blurStyle === style
                            ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                            : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
                        }`}
                      >
                        {style === 'gaussian' ? 'Blur' : 'Pixels'}
                      </button>
                    ))}
                  </div>
                  <input
                    type="range"
                    min={MIN_STRENGTH}
                    max={MAX_STRENGTH}
                    step={0.05}
                    value={blurStrength}
                    onChange={(e) => applyBlurStrength(Number(e.target.value))}
                    title={selectedBlur !== null
                      ? 'Strength of the selected region'
                      : 'Strength for the next drawn region'}
                    className="w-20 accent-[hsl(var(--status-purple))]"
                  />
                  <span className="min-w-[30px] font-mono text-[9px] text-[hsl(var(--muted-foreground))]">
                    {Math.round(blurStrength * 100)}%
                  </span>
                </>
              )}
              {blurs.length > 0 && (
                <button
                  onClick={() => { setBlurs([]); setSelectedBlur(null); }}
                  title="Remove every blur region"
                  className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
                >
                  Clear
                </button>
              )}

              <div className="mx-1 h-4 w-px bg-[hsl(var(--border))]" />

              <button onClick={() => nudgeZoom(1.15)} title="Zoom out" className="rounded p-1 hover:bg-[hsl(var(--accent))]">
                <ZoomOut size={13} />
              </button>
              <span className="min-w-[46px] text-center font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
                {crop ? `${zoomPercent(crop)}%` : 'none'}
              </span>
              <button onClick={() => nudgeZoom(1 / 1.15)} title="Zoom in" className="rounded p-1 hover:bg-[hsl(var(--accent))]">
                <ZoomIn size={13} />
              </button>

              <span className="ml-2 text-[10px] text-[hsl(var(--muted-foreground))]">
                {blurMode
                  ? 'drag to draw · click to select · × removes · Esc exits'
                  : 'drag to reposition · scroll to zoom'}
              </span>
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
            <div className="mx-1 h-4 w-px bg-[hsl(var(--border))]" />
            <button
              onClick={save}
              title="Save the crop and the redactions (the original image is never changed)"
              className="rounded-md bg-[hsl(var(--primary))] px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--primary-foreground))] hover:opacity-90"
            >
              Save
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
