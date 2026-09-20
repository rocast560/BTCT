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

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { PanelLeftClose, PanelLeftOpen, FileDown, Image, FileText, Images, Search } from 'lucide-react';
import { useAppStore } from '@/stores';
import type { BlurRegion, CropRect, ID, TypstAsset } from '@/types';
import { updateYTextContent } from '@/realtime/use-y-text';
import { useTypstSource } from './use-typst-source';
import {
  TypstEditor,
  revealTypstRange,
  getTypstCaret,
  insertAtTypstCursor,
  setTypstSearchRequest,
} from './TypstEditor';
import { TypstPreview, type SourceCandidate } from './TypstPreview';
import { TypstSearchPanel } from './TypstSearchPanel';
import { AssetsPanel } from '@/components/assets/AssetsPanel';
import {
  cancelTypstRelease,
  compileTypstPdf,
  compileTypstSvg,
  getFontInfo,
  scheduleTypstRelease,
  setTypstFonts,
  setTypstShadowFiles,
  typstErrorMessage,
} from '@/lib/typst-compiler';
import {
  exportOnServer,
  fetchExportCapabilities,
  serverExportNotice,
  type ExportCapabilities,
} from '@/lib/typst-export-api';
import { ASSET_DIR, assetPath, fetchAssetBytes, resolveAssetBytes } from '@/lib/assets';
import { matchAssetByHref } from '@/lib/asset-folders';
import {
  appendSlot,
  ensureHelper,
  findScreenshotSlots,
  retargetAssetPath,
  setSlotHeight,
  setSlotPath,
  type ScreenshotSlot,
} from '@/lib/typst-placeholders';
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

/** How long the source must be idle before the figure slots are re-scanned. */
const SLOT_SCAN_DEBOUNCE_MS = 300;

/**
 * Trailing-edge debounce.
 *
 * The source changes on every keystroke, but the slot scan it feeds only
 * labels thumbnails: it does not need to be frame-accurate. Debouncing keeps
 * a fast typist from re-parsing the whole document (and re-rendering the
 * thumbnail grid) ten times a second.
 */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

function triggerDownload(filename: string, data: BlobPart, mime: string): void {
  // A server export already arrives as a Blob of the right type. Wrapping it
  // in another Blob copies it, so a 100 MB Word file would sit in memory
  // twice for as long as the object URL lives.
  const blob = data instanceof Blob && data.type === mime ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // A synchronous revoke can race the browser's own read of the blob and
  // cancel the download before it starts, so free the URL on a timer instead.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Push the workspace's assets into the compiler's virtual filesystem and
 * font set, and report a revision that changes whenever they do, so the
 * preview recompiles after a drop or a crop, not just on a source edit.
 *
 * Images are resolved through `resolveAssetBytes`, which applies the crop
 * rectangle before the bytes ever reach Typst. Everything is memoized by
 * asset id + crop, so this is a no-op on re-renders where nothing moved.
 *
 * `ready` goes true once the compiler has been told about this workspace's
 * files at least once. Compiling before then renders the document with every
 * `#image("/assets/…")` unresolved, so the preview waits.
 */
function useTypstAssetSync(workspaceId: ID): { revision: number; ready: boolean } {
  const assets = useAppStore((s) => s.typstAssets);
  const loadTypstAssets = useAppStore((s) => s.loadTypstAssets);
  const [revision, setRevision] = useState(0);
  const [ready, setReady] = useState(false);

  // A different workspace means a different set of mounted files: nothing the
  // compiler holds right now belongs to it.
  useEffect(() => { setReady(false); }, [workspaceId]);

  // `loadTypstAssets` loads the *store's* `activeWorkspaceId`, not the
  // `workspaceId` this tab was opened for. They agree only because
  // `setActiveWorkspace` (app-store) empties `tabs`, so a Typst tab cannot
  // outlive the workspace it belongs to. If tabs are ever made to survive a
  // workspace switch, this tab would mount the other workspace's images into
  // the compiler and the rail, and both this effect and the panel's asset
  // list would need a workspace-scoped load instead.
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
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, [assets]);

  return { revision, ready };
}

export function TypstView({ workspaceId }: { workspaceId: ID }) {
  const ytext = useTypstSource(workspaceId);
  const typstAssets = useAppStore((s) => s.typstAssets);
  const addTypstAsset = useAppStore((s) => s.addTypstAsset);
  const setTypstAssetCrop = useAppStore((s) => s.setTypstAssetCrop);
  const renameTypstAsset = useAppStore((s) => s.renameTypstAsset);
  const workspaces = useAppStore((s) => s.workspaces);
  const workspaceName = workspaces.find((w) => w.id === workspaceId)?.name;
  // Ref mirror so the preview's click callback stays stable across renders.
  const typstAssetsRef = useRef(typstAssets);
  typstAssetsRef.current = typstAssets;
  const [source, setSource] = useState('');
  const [layout, setLayout] = useState<TypstLayout>(loadTypstLayout);
  const { showEditor, showAssets } = layout;
  const [exporting, setExporting] = useState(false);
  // One dismissible banner for anything the tab needs to say: a failed
  // export, or a snippet that went to the clipboard because the code pane
  // was closed. `kind` decides whether it reads as a failure or as a note;
  // an info banner is selectable, because some of them carry a snippet the
  // operator has to copy by hand.
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  // What the server can export, probed once on mount. Both stay false while
  // the check is in flight, so the two server buttons default to hidden
  // rather than flashing in.
  const [caps, setCaps] = useState<ExportCapabilities>({ pdf: false, docx: false });
  // Which server export (if any) is running. Separate from `exporting`
  // (the in-browser PDF/SVG state) because the server admits only two
  // queued exports at a time: only the two server buttons need to wait on
  // each other, and the browser export stays available regardless.
  const [serverExporting, setServerExporting] = useState<'pdf' | 'docx' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorPaneRef = useRef<HTMLDivElement>(null);
  const assetsPaneRef = useRef<HTMLDivElement>(null);
  const { revision: assetRevision, ready: assetsReady } = useTypstAssetSync(workspaceId);
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

  // Hold the compiler while the tab is mounted and hand it back when it
  // closes. The release is on a timer rather than immediate, because a pane
  // renders only its active tab and flicking between the report and a note
  // would otherwise rebuild the wasm every time (see lib/typst-compiler).
  useEffect(() => {
    cancelTypstRelease();
    return () => scheduleTypstRelease();
  }, []);

  // Probed once, not polled: the flag and the installed tools do not change
  // while the tab is open, and a cancelled flag keeps a slow response from
  // setting state after the tab has already unmounted.
  useEffect(() => {
    let cancelled = false;
    void fetchExportCapabilities().then((c) => { if (!cancelled) setCaps(c); });
    return () => { cancelled = true; };
  }, []);

  // `useTypstSource` refuses to seed a report until the websocket has synced
  // (see its header), so an offline client with no cached report sits on the
  // loading state indefinitely. After a few seconds say which of the two it
  // is, rather than leaving "Loading…" to imply something is still arriving.
  const [slowSync, setSlowSync] = useState(false);
  useEffect(() => {
    if (ytext) { setSlowSync(false); return; }
    const timer = window.setTimeout(() => setSlowSync(true), 4000);
    return () => window.clearTimeout(timer);
  }, [ytext]);

  // Programmatic source rewrites (assigning a screenshot to a figure slot,
  // adding a slot, search replace-all, rename retargeting) go through a
  // minimal CRDT delta rather than replacing the whole text, so a
  // collaborator typing elsewhere keeps their cursor and their edit merges
  // cleanly.
  //
  // Every caller hands over a function of the CURRENT source rather than a
  // finished string: `source` below is a 120 ms trailing mirror of the
  // Y.Text, and a rewrite computed from it deletes whatever arrived inside
  // that window (invariant #3b).
  const applySource = useCallback((compute: (current: string) => string) => {
    if (ytext) updateYTextContent(ytext, compute);
  }, [ytext]);

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

  // Assets rail: click-to-reveal from the preview (clicking a rendered figure
  // selects + flashes its asset card).
  const [assetReveal, setAssetReveal] = useState<{ id: ID; nonce: number } | null>(null);
  const revealImage = useCallback((href: string) => {
    void (async () => {
      const images = typstAssetsRef.current.filter((a) => a.kind === 'image');
      const match = await matchAssetByHref(href, images, resolveAssetBytes);
      if (!match) return;
      if (!visibleRef.current.assets) {
        setLayout((prev) => {
          const merged = { ...prev, showAssets: true };
          saveTypstLayout(merged);
          return merged;
        });
      }
      setAssetReveal({ id: match.id, nonce: Date.now() });
    })();
  }, []);

  /**
   * Assets rail "insert": drop a reference to the asset at the caret.
   *
   * Figure slots are the primary route for a screenshot, because they keep
   * captions and numbering consistent, so the image form is the escape hatch
   * for one that belongs inline; a font has no other route at all. With the
   * code pane closed there is no caret to insert at, so the snippet goes to
   * the clipboard rather than nowhere.
   *
   * `navigator.clipboard` only exists in a secure context, and the usual
   * deployment of this app is plain HTTP on a LAN, where it is undefined.
   * Claiming a copy that never happened is worse than not copying, so when
   * there is no clipboard (or it refuses) the snippet goes into the banner
   * itself, where it can be selected by hand.
   */
  const insertAsset = useCallback((asset: TypstAsset) => {
    const snippet = asset.kind === 'font'
      ? `#set text(font: "${asset.fontFamily}")\n`
      : `#image("${assetPath(asset)}")\n`;
    if (insertAtTypstCursor(snippet)) return;
    const byHand = () => setNotice({
      kind: 'info',
      text: `Code editor is hidden and the clipboard is unavailable here. Copy this: ${snippet.trim()}`,
    });
    const clipboard = navigator.clipboard;
    if (!clipboard) { byHand(); return; }
    void clipboard.writeText(snippet).then(
      () => setNotice({ kind: 'info', text: 'Code editor is hidden: snippet copied to the clipboard instead.' }),
      byHand,
    );
  }, []);

  /**
   * Upload a font for the assets rail.
   *
   * The family name is what the operator types into `#set text(font: "…")`,
   * and only typst.ts's own parser knows the name the compiler will match, so
   * it is read here (the tab already owns the compiler) rather than in the
   * shared panel, which would otherwise drag the wasm engine into the Assets
   * Manager tab. A font whose name will not parse still uploads: the compiler
   * can use it, the rail just shows the filename and cannot offer the
   * snippet.
   */
  const addFont = useCallback(async (file: File, folderId: ID | null) => {
    let family: string | null = null;
    try {
      family = (await getFontInfo(new Uint8Array(await file.arrayBuffer())))?.family ?? null;
    } catch { /* family stays unknown; FontRow falls back to the filename */ }
    await addTypstAsset(file, 'font', folderId, family);
  }, [addTypstAsset]);

  // ── Figure slots ───────────────────────────────────────────────────────
  // The assets rail shows which figure each image fills and writes a chosen
  // one back into the document. Every rewrite lands here rather than in the
  // panel, because this component owns the source Y.Text.

  // Which figure (if any) each image currently fills, keyed by asset path.
  // Scanned off a debounced copy of the source: the labels are cosmetic, so
  // they can lag a keystroke rather than re-parsing on each one.
  const settledSource = useDebounced(source, SLOT_SCAN_DEBOUNCE_MS);
  const placements = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of findScreenshotSlots(settledSource)) {
      if (s.path) map.set(s.path, s.caption ?? `figure on line ${s.line}`);
    }
    return map;
  }, [settledSource]);

  /**
   * Commit a crop and (optionally) an assignment to a figure slot.
   *
   * Order matters: the helper definition is upgraded/inserted *first*, then
   * the slots are re-scanned against that new source before rewriting one.
   * Editing the slot using offsets measured against the pre-upgrade source
   * would splice into the wrong position once the helper shifted everything
   * below it.
   */
  const placeAsset = useCallback(
    (
      asset: TypstAsset,
      crop: CropRect | null,
      blurs: BlurRegion[] | null,
      slot: ScreenshotSlot | null,
      path: string | null,
      heightPt: number | null,
    ) => {
      void setTypstAssetCrop(asset.id, crop, blurs);
      if (!slot) return;

      // `slot.index` was chosen in the dialog against the debounced mirror,
      // so a collaborator who added a slot above it in the meantime would
      // shift which figure this writes into. Known and deliberately left:
      // fixing it needs a stable slot identity, not a fresher read.
      applySource((current) => {
        let next = ensureHelper(current).source;

        // Each rewrite shifts the offsets of everything after it, so re-scan
        // between edits and re-find the slot by its document order.
        if (heightPt !== null) {
          const target = findScreenshotSlots(next)[slot.index];
          if (target) next = setSlotHeight(next, target, heightPt);
        }
        const target = findScreenshotSlots(next)[slot.index];
        if (target) next = setSlotPath(next, target, path);
        return next;
      });
    },
    [setTypstAssetCrop, applySource],
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
    (asset: TypstAsset, stem: string) => {
      const oldPath = assetPath(asset);
      void renameTypstAsset(asset.id, stem)
        .then((filename) => {
          const newPath = `${ASSET_DIR}/${filename}`;
          if (newPath === oldPath) return;
          applySource((current) => retargetAssetPath(current, oldPath, newPath));
        })
        .catch((e) => setNotice({ kind: 'error', text: e instanceof Error ? e.message : String(e) }));
    },
    [renameTypstAsset, applySource],
  );

  const addSlot = useCallback((caption: string) => {
    applySource((current) => appendSlot(current, caption));
  }, [applySource]);

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
    setNotice(null);
    try {
      const bytes = await compileTypstPdf(source);
      triggerDownload('document.pdf', bytes as BlobPart, 'application/pdf');
    } catch (err) {
      setNotice({ kind: 'error', text: `PDF export failed: ${typstErrorMessage(err)}` });
    } finally {
      setExporting(false);
    }
  }, [source]);

  const exportSvg = useCallback(async () => {
    setExporting(true);
    setNotice(null);
    try {
      const res = await compileTypstSvg(source);
      if (!res.svg) {
        const msg = res.diagnostics.find((d) => d.severity === 'error')?.message ?? 'document has errors';
        setNotice({ kind: 'error', text: `SVG export failed: ${msg}` });
        return;
      }
      triggerDownload('document.svg', res.svg, 'image/svg+xml');
    } catch (err) {
      setNotice({ kind: 'error', text: `SVG export failed: ${typstErrorMessage(err)}` });
    } finally {
      setExporting(false);
    }
  }, [source]);

  /**
   * DOCX / PDF (server): compile (or convert) on the server, with the
   * workspace's redactions baked into the images first. Unlike the in-browser
   * PDF/SVG buttons this leaves the document, so a failure reports whatever
   * the server already scrubbed and worded for an operator (a Typst
   * diagnostic with its file and line, a queue-full sentence, a missing
   * binary) rather than something derived here.
   */
  const serverExport = useCallback(async (format: 'pdf' | 'docx') => {
    setServerExporting(format);
    setNotice(null);
    try {
      const { blob, baked, warnings } = await exportOnServer(workspaceId, format);
      triggerDownload(`${workspaceName ?? 'report'}.${format}`, blob, blob.type);
      const text = serverExportNotice(baked, warnings);
      if (text) setNotice({ kind: 'info', text });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setServerExporting(null);
    }
  }, [workspaceId, workspaceName]);

  /**
   * The assets rail's props, as one stable object.
   *
   * `AssetsPanel` is memoized, and this view re-renders every 120 ms while
   * anyone is typing, so an object literal in the JSX would re-render the
   * whole rail (thumbnails included) on each of those. The source it carries
   * is the settled one the slot scan already uses: only the placement dialog
   * reads it, and 300 ms old is fresh enough to list the current slots.
   */
  const panelMode = useMemo(() => ({
    source: settledSource,
    placements,
    onInsert: insertAsset,
    onAddFont: addFont,
    onPlace: placeAsset,
    onAddSlot: addSlot,
    onRename: renameAsset,
    reveal: assetReveal,
  }), [settledSource, placements, insertAsset, addFont, placeAsset, addSlot, renameAsset, assetReveal]);

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
          {caps.docx && (
            <button
              onClick={() => void serverExport('docx')}
              disabled={serverExporting !== null}
              title="Word file made on the server from the finished PDF, matching its layout line for line. Redactions are baked in first. The report's fonts are embedded when their licence allows it."
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))] disabled:opacity-40"
            >
              <FileDown size={13} /> {serverExporting === 'docx' ? 'Converting…' : 'DOCX'}
            </button>
          )}
          {caps.pdf && (
            <button
              onClick={() => void serverExport('pdf')}
              disabled={serverExporting !== null}
              title="Compiled by the server's typst CLI, with redactions baked into the images first."
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))] disabled:opacity-40"
            >
              <FileDown size={13} /> {serverExporting === 'pdf' ? 'Compiling…' : 'PDF (server)'}
            </button>
          )}
        </div>
      </div>
      {notice && (
        <div
          className={`flex shrink-0 items-center gap-3 border-b px-3 py-1.5 text-xs ${
            notice.kind === 'error'
              ? 'border-[hsl(var(--status-red))]/30 bg-[hsl(var(--status-red))]/10 text-[hsl(var(--status-red))]'
              : 'border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] text-[hsl(var(--muted-foreground))]'
          }`}
        >
          {/* An info notice can carry a snippet to copy by hand, so it wraps
              and stays selectable instead of being truncated to one line. */}
          <span
            className={`min-w-0 flex-1 ${notice.kind === 'error' ? 'truncate' : 'select-text whitespace-pre-wrap break-words'}`}
            title={notice.text}
          >
            {notice.text}
          </span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className={`shrink-0 rounded-md px-2 py-0.5 ${
              notice.kind === 'error' ? 'hover:bg-[hsl(var(--status-red))]/15' : 'hover:bg-[hsl(var(--accent))]'
            }`}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Editor | Preview | Assets.
          `contain: layout paint` on each pane keeps a width change from
          relayouting or repainting the other two: the preview's SVG in
          particular can be a very large subtree. */}
      <div ref={containerRef} className="relative flex min-h-0 flex-1">
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
                <div className="flex h-full items-center justify-center px-6 text-center text-xs text-[hsl(var(--muted-foreground))]">
                  {slowSync ? 'Waiting for the workspace to sync…' : 'Loading…'}
                </div>
              )}
            </div>
            <PaneDivider onPointerDown={startResize('editor')} onDoubleClick={resetPane('editor')} />
          </>
        )}

        <div className="min-w-0 flex-1 overflow-hidden" style={{ contain: 'layout paint' }}>
          <TypstPreview
            source={source}
            revision={assetRevision}
            mainPath="/main.typ"
            docKey={workspaceId}
            ready={ytext !== null && assetsReady}
            onRevealSource={revealSource}
            onRevealImage={revealImage}
          />
        </div>

        {showAssets && (
          <>
            <PaneDivider onPointerDown={startResize('assets')} onDoubleClick={resetPane('assets')} />
            <div
              ref={assetsPaneRef}
              className="min-w-0 shrink-0 overflow-hidden"
              style={{ width: `${layout.assets}px`, contain: 'layout paint' }}
            >
              {/* The same panel the Assets Manager tab renders. The `typst`
                  prop is what turns it into the report's rail: figure-slot
                  placement, insert-at-caret and the narrow layout. */}
              <AssetsPanel typst={panelMode} />
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
