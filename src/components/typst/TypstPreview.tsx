// ─────────────────────────────────────────────────────────────────────────
// Live, locally-rendered Typst preview.
//
// Debounces the source, compiles it to SVG in-browser (see lib/typst-compiler)
// and shows the rendered page. Compile errors surface as a banner with the
// Typst diagnostics (file:line ranges) while the last good render stays
// visible, so a transient typo doesn't blank the preview.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import { ZoomIn, ZoomOut, Maximize, Loader2, AlertTriangle } from 'lucide-react';
import { compileTypstSvg, typstErrorMessage, type TypstDiagnostic } from '@/lib/typst-compiler';
import { separateTypstPages } from '@/lib/typst-pages';

const DEBOUNCE_MS = 350;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;

// Memoized so it only re-renders when `source` actually changes — in
// particular it is skipped entirely while the user drags the editor/preview
// divider (which only changes the parent's width state).
export const TypstPreview = memo(function TypstPreview({ source }: { source: string }) {
  const [svg, setSvg] = useState<string>('');
  const [diagnostics, setDiagnostics] = useState<TypstDiagnostic[]>([]);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [firstLoad, setFirstLoad] = useState(true);
  const [compiling, setCompiling] = useState(false);
  const [zoom, setZoom] = useState(1);

  // Monotonic id so a slow compile that finishes after a newer one can't
  // overwrite the fresher result.
  const runId = useRef(0);

  useEffect(() => {
    const id = ++runId.current;
    setCompiling(true);
    const timer = setTimeout(() => {
      void compileTypstSvg(source)
        .then((res) => {
          if (id !== runId.current) return;
          setFatalError(null);
          setDiagnostics(res.diagnostics);
          if (res.svg) setSvg(res.svg); // keep last good render on error
        })
        .catch((err) => {
          if (id !== runId.current) return;
          setFatalError(typstErrorMessage(err));
        })
        .finally(() => {
          if (id !== runId.current) return;
          setCompiling(false);
          setFirstLoad(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [source]);

  const errors = diagnostics.filter((d) => d.severity === 'error');

  // Reflow the SVG so multi-page documents render as separated, white page
  // cards instead of one continuous sheet. Recomputed only when the SVG changes.
  const { svg: displaySvg, pages } = useMemo(() => separateTypstPages(svg), [svg]);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(MAX_ZOOM, +(z + 0.1).toFixed(2))), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(MIN_ZOOM, +(z - 0.1).toFixed(2))), []);
  const resetZoom = useCallback(() => setZoom(1), []);

  return (
    <div className="flex h-full flex-col bg-[hsl(var(--muted)/0.35)]">
      {/* Toolbar */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
          {compiling ? (
            <>
              <Loader2 size={11} className="animate-spin" /> Rendering
            </>
          ) : errors.length > 0 ? (
            <span className="text-[hsl(var(--status-red))]">{errors.length} error{errors.length > 1 ? 's' : ''}</span>
          ) : (
            'Preview'
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={zoomOut} title="Zoom out" className="rounded p-1 hover:bg-[hsl(var(--accent))]">
            <ZoomOut size={13} />
          </button>
          <button onClick={resetZoom} title="Reset zoom" className="min-w-[42px] rounded px-1 py-0.5 text-center font-mono text-[10px] hover:bg-[hsl(var(--accent))]">
            {Math.round(zoom * 100)}%
          </button>
          <button onClick={zoomIn} title="Zoom in" className="rounded p-1 hover:bg-[hsl(var(--accent))]">
            <ZoomIn size={13} />
          </button>
          <button onClick={resetZoom} title="Fit width" className="rounded p-1 hover:bg-[hsl(var(--accent))]">
            <Maximize size={13} />
          </button>
        </div>
      </div>

      {/* Error banner (overlaps the last good render) */}
      {fatalError ? (
        <div className="flex items-start gap-2 border-b border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-3 py-2 text-[11px] text-[hsl(var(--status-red))]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="font-mono">{fatalError}</span>
        </div>
      ) : errors.length > 0 ? (
        <div className="max-h-32 shrink-0 overflow-y-auto border-b border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-3 py-2">
          {errors.map((d, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px] text-[hsl(var(--status-red))]">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span className="font-mono">
                {(d.path || d.range) && (
                  <span className="opacity-70">{[d.path, d.range].filter(Boolean).join(':')} — </span>
                )}
                {d.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Rendered document. `contain` isolates the (potentially large) SVG
          subtree so resizing the pane doesn't relayout it beyond this box. */}
      <div className="relative flex-1 overflow-auto p-6" style={{ contain: 'layout paint' }}>
        {firstLoad && !svg ? (
          <div className="flex h-full items-center justify-center text-center text-xs text-[hsl(var(--muted-foreground))]">
            <div className="flex flex-col items-center gap-2">
              <Loader2 size={18} className="animate-spin" />
              Loading the Typst compiler…
              <span className="text-[10px] opacity-70">(first render initializes the local WASM engine)</span>
            </div>
          </div>
        ) : svg ? (
          <div className="mx-auto w-fit" style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}>
            {/* SVG is produced by the local WASM compiler from the operator's own
                source (no remote input) — consistent with the app's trusted-LAN
                threat model. When pages are recognized each gets its own white
                card (drawn into the SVG); otherwise fall back to a single card. */}
            {pages > 0 ? (
              <div
                className="[&>svg]:block [&>svg]:h-auto [&>svg]:max-w-none"
                dangerouslySetInnerHTML={{ __html: displaySvg }}
              />
            ) : (
              <div
                className="rounded bg-white shadow-lg [&>svg]:block [&>svg]:h-auto [&>svg]:max-w-none"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">
            Nothing to render yet — start typing Typst on the left.
          </div>
        )}
      </div>
    </div>
  );
});
