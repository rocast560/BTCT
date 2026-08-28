// ─────────────────────────────────────────────────────────────────────────
// Typst tab: a typst.app-style split view rendered entirely locally.
//
// Left: the raw Typst source in a collaborative CodeMirror editor.
// Right: the live, in-browser-compiled preview.
//
// The source is a single per-workspace Y.Text (`typst:<workspaceId>:source`)
// in the shared doc, so it's persisted and collaboratively edited like every
// other text field in BTCT. There is one Typst scratchpad document per
// workspace.
// ─────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';
import * as Y from 'yjs';
import { PanelLeftClose, PanelLeftOpen, FileDown, Image, FileText, Images, Search } from 'lucide-react';
import { useAppStore } from '@/stores';
import { getSharedDoc, getOrInitYText, textKey } from '@/realtime/shared-doc';
import { replaceYTextContent } from '@/realtime/use-y-text';
import { TypstEditor, revealTypstRange, getTypstCaret, setTypstSearchRequest } from './TypstEditor';
import { TypstPreview, type SourceCandidate } from './TypstPreview';
import { TypstSearchPanel } from './TypstSearchPanel';
import { TypstAssetsPanel } from './TypstAssetsPanel';
import {
  compileTypstPdf,
  compileTypstSvg,
  setTypstFonts,
  setTypstShadowFiles,
  typstErrorMessage,
} from '@/lib/typst-compiler';
import { assetPath, fetchAssetBytes, resolveAssetBytes } from '@/lib/typst-assets';
import { PLACEHOLDER_HELPER } from '@/lib/typst-placeholders';
import { findSourceRange, type SourceRange } from '@/lib/typst-source-map';
import {
  clampPaneWidth,
  fitPanes,
  loadTypstLayout,
  saveTypstLayout,
  PANE_DEFAULT,
  type PaneKind,
  type TypstLayout,
} from '@/lib/pane-resize';

// Starter document shown the first time a workspace's Typst doc is opened.
//
// Ships with the `image-placeholder` helper pre-defined: screenshots are
// assigned to declared figure slots from the Assets rail rather than pasted
// at the caret, so captions and numbering stay consistent. An unfilled slot
// renders as a labelled grey box, making a missing screenshot obvious in the
// PDF instead of silently absent.
const DEFAULT_TYPST_TEMPLATE = `#set page(margin: 1.5cm)
#set text(font: "New Computer Modern", size: 11pt)
#set heading(numbering: "1.1")

${PLACEHOLDER_HELPER}

#align(center)[
  #text(size: 20pt, weight: "bold")[Engagement Report] \\
  #text(size: 11pt)[Been There, Conquered That]
]

= Executive Summary

Write a high-level summary of the engagement here. Typst renders this
preview locally: no internet required.

= Findings

== Example Finding

#table(
  columns: (auto, 1fr),
  [*Severity*], [High],
  [*CVSS*], [8.1],
  [*Affected*], [10.0.0.5],
)

Describe the finding, its impact, and remediation steps.

#image-placeholder("Proof of exploitation")
`;

/** Bind to the per-workspace Typst source Y.Text, seeding it on first open. */
function useTypstSource(workspaceId: string): Y.Text | null {
  const [ytext, setYtext] = useState<Y.Text | null>(null);

  useEffect(() => {
    const key = textKey('typst', workspaceId, 'source');
    const texts = getSharedDoc().texts;
    // Get-or-create the slot, seeding the template only when it has never
    // existed (an intentionally-cleared doc keeps an empty Y.Text, so it is
    // not re-seeded).
    let current = getOrInitYText(key, DEFAULT_TYPST_TEMPLATE);
    setYtext(current);

    // Rebind if the canonical Y.Text in the slot is replaced via sync (the
    // rare two-clients-seed-at-once case) so we never edit an orphan.
    const onMapChange = (ev: Y.YMapEvent<Y.Text>) => {
      if (!ev.changes.keys.has(key)) return;
      const next = texts.get(key);
      if (next && next !== current) {
        current = next;
        setYtext(next);
      }
    };
    texts.observe(onMapChange);
    return () => texts.unobserve(onMapChange);
  }, [workspaceId]);

  return ytext;
}

function triggerDownload(filename: string, data: BlobPart, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function TypstView() {
  const workspaceId = useAppStore((s) => s.activeWorkspaceId);

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
        Select a workspace to use the Typst editor.
      </div>
    );
  }

  return <TypstWorkspaceView workspaceId={workspaceId} />;
}

/**
 * Push the workspace's assets into the compiler's virtual filesystem and
 * font set, and report a revision that changes whenever they do, so the
 * preview recompiles after a drop or a crop, not just on a source edit.
 *
 * Images are resolved through `resolveAssetBytes`, which applies the crop
 * rectangle before the bytes ever reach Typst. Everything is memoized by
 * asset id + crop, so this is a no-op on re-renders where nothing moved.
 */
function useTypstAssetSync(workspaceId: string): number {
  const assets = useAppStore((s) => s.typstAssets);
  const loadTypstAssets = useAppStore((s) => s.loadTypstAssets);
  const [revision, setRevision] = useState(0);

  useEffect(() => { void loadTypstAssets(); }, [loadTypstAssets, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const images = assets.filter((a) => a.kind === 'image');
      const fonts = assets.filter((a) => a.kind === 'font');

      // allSettled: one asset whose bytes went missing (volume wiped, blob
      // deleted out-of-band) must not take down every other image in the
      // document. Failures are simply left unmounted, and Typst reports the
      // unresolved path against the exact line that referenced it.
      const [imageResults, fontResults] = await Promise.all([
        Promise.allSettled(
          images.map(async (a) => ({ path: assetPath(a), bytes: await resolveAssetBytes(a) })),
        ),
        Promise.allSettled(fonts.map((a) => fetchAssetBytes(a.id))),
      ]);
      if (cancelled) return;

      const files = imageResults
        .filter((r): r is PromiseFulfilledResult<{ path: string; bytes: Uint8Array }> =>
          r.status === 'fulfilled')
        .map((r) => r.value);
      const fontBytes = fontResults
        .filter((r): r is PromiseFulfilledResult<Uint8Array> => r.status === 'fulfilled')
        .map((r) => r.value);

      const filesChanged = setTypstShadowFiles(files);
      const fontsChanged = setTypstFonts(fontBytes);
      if (filesChanged || fontsChanged) setRevision((r) => r + 1);
    })();
    return () => { cancelled = true; };
  }, [assets]);

  return revision;
}

function TypstWorkspaceView({ workspaceId }: { workspaceId: string }) {
  const ytext = useTypstSource(workspaceId);
  const [source, setSource] = useState('');
  const [layout, setLayout] = useState<TypstLayout>(loadTypstLayout);
  const { showEditor, showAssets } = layout;
  const [exporting, setExporting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorPaneRef = useRef<HTMLDivElement>(null);
  const assetsPaneRef = useRef<HTMLDivElement>(null);
  const assetRevision = useTypstAssetSync(workspaceId);
  // Mirrors `source` so the reveal callback can stay stable across keystrokes.
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // Live pane widths, mirrored into refs so the drag handler reads the current
  // value without re-subscribing and without depending on a render.
  const widthsRef = useRef({ editor: layout.editor, assets: layout.assets });
  widthsRef.current = { editor: layout.editor, assets: layout.assets };
  const visibleRef = useRef({ editor: showEditor, assets: showAssets });
  visibleRef.current = { editor: showEditor, assets: showAssets };

  // Teardown for an in-progress drag (removes the listeners, the cursor lock,
  // and any queued frame). Set while dragging, null otherwise, so the unmount
  // effect can tear down a drag that's still active.
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Mirror the Y.Text content into React state so the preview re-renders as
  // the source changes (local or remote). Each observer fire does an
  // O(document) toString() and re-renders the preview/assets/search panels,
  // so coalesce a burst of keystrokes into one trailing update per frame-ish
  // window. The first value is set synchronously so first paint has content,
  // and every downstream consumer (compile, slot scan, search) debounces
  // further on top of this, so 120ms of mirror lag is invisible.
  useEffect(() => {
    if (!ytext) return;
    setSource(ytext.toString());
    let timer: number | null = null;
    const update = () => {
      if (timer != null) return;
      timer = window.setTimeout(() => { timer = null; setSource(ytext.toString()); }, 120);
    };
    ytext.observe(update);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      ytext.unobserve(update);
    };
  }, [ytext]);

  // Defensive: if the tab unmounts mid-drag, tear the drag down (removes the
  // orphaned document listeners, cancels the queued frame, and undoes the
  // global cursor/selection lock that mouseup would normally clear).
  useEffect(() => () => { dragCleanupRef.current?.(); }, []);

  // Programmatic source rewrites (assigning a screenshot to a figure slot,
  // adding a slot) go through a minimal CRDT delta rather than replacing the
  // whole text, so a collaborator typing elsewhere keeps their cursor and
  // their edit merges cleanly.
  const applySource = useCallback((next: string) => {
    if (ytext) replaceYTextContent(ytext, next);
  }, [ytext]);

  /**
   * Click-to-source: jump the caret to whatever was clicked in the preview.
   *
   * Opens the code pane first if it's hidden: the whole point of the gesture
   * is to land on the source, so silently doing nothing because the editor is
   * collapsed would be the wrong call. The reveal is deferred a frame so the
   * newly-mounted CodeMirror instance exists before we drive it.
   */
  /**
   * Select `[from, to)` in the editor, opening the (possibly hidden) code pane
   * first. Shared by click-to-source and the search panel. When the pane has
   * to be revealed, the CodeMirror instance mounts a frame later, so the
   * selection is deferred to the next frame.
   */
  const revealRange = useCallback((from: number, to: number, focus = true) => {
    if (!visibleRef.current.editor) {
      setLayout((prev) => {
        const merged = { ...prev, showEditor: true };
        saveTypstLayout(merged);
        return merged;
      });
      requestAnimationFrame(() => revealTypstRange(from, to, focus));
      return;
    }
    revealTypstRange(from, to, focus);
  }, []);

  // The search panel selects matches without stealing focus from its input, so
  // repeated Enter keeps stepping through results.
  const revealForSearch = useCallback(
    (from: number, to: number) => revealRange(from, to, false),
    [revealRange],
  );

  const revealSource = useCallback((candidates: SourceCandidate[]) => {
    let hit: SourceRange | null = null;
    for (const c of candidates) {
      hit = findSourceRange(sourceRef.current, c.text, c.occurrence);
      if (hit) break;
    }
    if (hit) revealRange(hit.from, hit.to);
  }, [revealRange]);

  // Whole-document find & replace panel (lib/typst-search). Ctrl/⌘+F inside the
  // editor and the header's Find button both route here; opening it reveals the
  // code pane so there's something to search into.
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => {
    if (!visibleRef.current.editor) {
      setLayout((prev) => {
        const merged = { ...prev, showEditor: true };
        saveTypstLayout(merged);
        return merged;
      });
    }
    setSearchOpen(true);
  }, []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  // Bridge the editor's Ctrl/⌘+F keybinding to this panel while the tab is
  // mounted.
  useEffect(() => {
    setTypstSearchRequest(openSearch);
    return () => setTypstSearchRequest(null);
  }, [openSearch]);

  /**
   * Drag one of the two dividers.
   *
   * The width is written straight to the pane's own style during the drag and
   * committed to React state only on release, so a resize costs one style
   * mutation per frame instead of a full re-render of the tab. That matters
   * here more than in most layouts: a re-render mid-drag would reconcile the
   * assets rail and (worse) risk remounting the CodeMirror host, which would
   * drop the Yjs collab binding and every remote cursor with it.
   *
   * The container geometry is read once at drag start; reading it per-move
   * forces a synchronous reflow on every event, which is most of the lag in a
   * naive implementation.
   */
  const startResize = useCallback((which: PaneKind) => (e: React.PointerEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const paneEl = which === 'editor' ? editorPaneRef.current : assetsPaneRef.current;
    if (!paneEl) return;

    const containerWidth = container.getBoundingClientRect().width;
    const startX = e.clientX;
    const startWidth = widthsRef.current[which];
    const other = which === 'editor'
      ? (visibleRef.current.assets ? widthsRef.current.assets : 0)
      : (visibleRef.current.editor ? widthsRef.current.editor : 0);

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    let frame = 0;
    let next = startWidth;

    const onMove = (ev: PointerEvent) => {
      // The editor grows as the pointer moves right; the assets rail is on
      // the far side, so it grows as the pointer moves left.
      const delta = ev.clientX - startX;
      const raw = which === 'editor' ? startWidth + delta : startWidth - delta;
      next = clampPaneWidth(which, raw, containerWidth, other);
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          paneEl.style.width = `${next}px`;
        });
      }
    };

    const cleanup = () => {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      dragCleanupRef.current = null;
    };

    const onUp = () => {
      cleanup();
      // Single commit: React state catches up to the DOM we've been driving.
      setLayout((prev) => {
        const merged = { ...prev, [which]: next };
        saveTypstLayout(merged);
        return merged;
      });
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  /** Double-click a divider to restore that pane's default width. */
  const resetPane = useCallback((which: PaneKind) => () => {
    setLayout((prev) => {
      const merged = { ...prev, [which]: PANE_DEFAULT[which] };
      saveTypstLayout(merged);
      return merged;
    });
  }, []);

  const togglePane = useCallback((which: PaneKind) => () => {
    setLayout((prev) => {
      const key = which === 'editor' ? 'showEditor' : 'showAssets';
      const merged = { ...prev, [key]: !prev[key] };
      saveTypstLayout(merged);
      return merged;
    });
  }, []);

  // Keep both rails inside the container when it changes size (window resize,
  // sidebar toggle, pane split). Without this a layout saved on a wide monitor
  // can leave no room for the preview on a narrow one.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width <= 0) return;
      setLayout((prev) => {
        const fitted = fitPanes(
          { editor: prev.editor, assets: prev.assets },
          { editor: prev.showEditor, assets: prev.showAssets },
          width,
        );
        if (fitted.editor === prev.editor && fitted.assets === prev.assets) return prev;
        return { ...prev, ...fitted };
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const exportPdf = useCallback(async () => {
    setExporting(true);
    try {
      const bytes = await compileTypstPdf(source);
      triggerDownload('document.pdf', bytes as BlobPart, 'application/pdf');
    } catch (err) {
      window.alert(`PDF export failed:\n${typstErrorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  }, [source]);

  const exportSvg = useCallback(async () => {
    setExporting(true);
    try {
      const res = await compileTypstSvg(source);
      if (!res.svg) {
        const msg = res.diagnostics.find((d) => d.severity === 'error')?.message ?? 'document has errors';
        window.alert(`SVG export failed:\n${msg}`);
        return;
      }
      triggerDownload('document.svg', res.svg, 'image/svg+xml');
    } catch (err) {
      window.alert(`SVG export failed:\n${typstErrorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  }, [source]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div data-ui="toolbar" className="flex h-9 shrink-0 items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3">
        <div className="flex items-center gap-2">
          <FileText size={13} className="text-[hsl(var(--status-purple))]" />
          <span className="text-[11px] font-bold uppercase tracking-widest text-[hsl(var(--foreground))]">Typst</span>
          <span className="text-[10px] text-[hsl(var(--muted-foreground))]">locally rendered</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={togglePane('editor')}
            title={showEditor ? 'Hide code editor' : 'Show code editor'}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
          >
            {showEditor ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
            Code
          </button>
          <button
            onClick={openSearch}
            title="Search the document (Ctrl/⌘+F)"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
          >
            <Search size={13} /> Find
          </button>
          <button
            onClick={togglePane('assets')}
            title={showAssets ? 'Hide assets panel' : 'Show assets panel'}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))] ${
              showAssets ? 'text-[hsl(var(--foreground))]' : 'text-[hsl(var(--muted-foreground))]'
            }`}
          >
            <Images size={13} /> Assets
          </button>
          <div className="mx-1 h-4 w-px bg-[hsl(var(--border))]" />
          <button
            onClick={exportSvg}
            disabled={exporting}
            title="Export SVG"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))] disabled:opacity-40"
          >
            <Image size={13} /> SVG
          </button>
          <button
            onClick={exportPdf}
            disabled={exporting}
            title="Export PDF"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))] disabled:opacity-40"
          >
            <FileDown size={13} /> PDF
          </button>
        </div>
      </div>

      {/* Editor | Preview | Assets.
          `contain: layout paint` on each pane keeps a width change from
          relayouting or repainting the other two: the preview's SVG in
          particular can be a very large subtree. */}
      <div ref={containerRef} className="flex min-h-0 flex-1">
        {showEditor && (
          <>
            <div
              ref={editorPaneRef}
              className="relative min-w-0 shrink-0 overflow-hidden"
              style={{ width: `${layout.editor}px`, contain: 'layout paint' }}
            >
              {searchOpen && ytext && (
                <TypstSearchPanel
                  source={source}
                  caret={getTypstCaret()}
                  onReveal={revealForSearch}
                  onReplaceSource={applySource}
                  onClose={closeSearch}
                />
              )}
              {ytext ? (
                <TypstEditor ytext={ytext} />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">Loading…</div>
              )}
            </div>
            <PaneDivider onPointerDown={startResize('editor')} onDoubleClick={resetPane('editor')} />
          </>
        )}

        <div className="min-w-0 flex-1 overflow-hidden" style={{ contain: 'layout paint' }}>
          <TypstPreview source={source} revision={assetRevision} onRevealSource={revealSource} />
        </div>

        {showAssets && (
          <>
            <PaneDivider onPointerDown={startResize('assets')} onDoubleClick={resetPane('assets')} />
            <div
              ref={assetsPaneRef}
              className="min-w-0 shrink-0 overflow-hidden"
              style={{ width: `${layout.assets}px`, contain: 'layout paint' }}
            >
              <TypstAssetsPanel source={source} onSourceChange={applySource} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Drag handle between two panes.
 *
 * The visible rule is 1px but the grab area is padded out to 9px via a
 * transparent overlay: a 1px hit target is genuinely hard to grab, and
 * widening the rule itself would put a chunky line through the layout.
 */
function PaneDivider({
  onPointerDown,
  onDoubleClick,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title="Drag to resize · double-click to reset"
      className="group relative w-px shrink-0 cursor-col-resize bg-[hsl(var(--border))]"
    >
      <div className="absolute inset-y-0 -left-1 -right-1 z-10 transition-colors group-hover:bg-[hsl(var(--primary))]/60" />
    </div>
  );
}
