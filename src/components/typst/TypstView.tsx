// ─────────────────────────────────────────────────────────────────────────
// Typst tab — a typst.app-style split view rendered entirely locally.
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
import { PanelLeftClose, PanelLeftOpen, FileDown, Image, FileText } from 'lucide-react';
import { useAppStore } from '@/stores';
import { getSharedDoc, getOrInitYText, textKey } from '@/realtime/shared-doc';
import { TypstEditor } from './TypstEditor';
import { TypstPreview } from './TypstPreview';
import { compileTypstPdf, compileTypstSvg, typstErrorMessage } from '@/lib/typst-compiler';

// Starter document shown the first time a workspace's Typst doc is opened.
const DEFAULT_TYPST_TEMPLATE = `#set page(margin: 1.5cm)
#set text(font: "New Computer Modern", size: 11pt)
#set heading(numbering: "1.1")

#align(center)[
  #text(size: 20pt, weight: "bold")[Engagement Report] \\
  #text(size: 11pt)[Been There, Conquered That]
]

= Executive Summary

Write a high-level summary of the engagement here. Typst renders this
preview locally — no internet required.

= Findings

== Example Finding

#table(
  columns: (auto, 1fr),
  [*Severity*], [High],
  [*CVSS*], [8.1],
  [*Affected*], [10.0.0.5],
)

Describe the finding, its impact, and remediation steps.
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

function TypstWorkspaceView({ workspaceId }: { workspaceId: string }) {
  const ytext = useTypstSource(workspaceId);
  const [source, setSource] = useState('');
  const [showEditor, setShowEditor] = useState(true);
  const [editorPct, setEditorPct] = useState(0.5);
  const [exporting, setExporting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Resize bookkeeping. editorPctRef mirrors state so the drag handler can read
  // the latest width without re-subscribing; pendingPctRef holds the in-flight
  // value; rafRef coalesces mousemoves to one update per animation frame.
  const editorPctRef = useRef(editorPct);
  editorPctRef.current = editorPct;
  const pendingPctRef = useRef(editorPct);
  const rafRef = useRef(0);
  // Teardown for an in-progress drag (removes the document listeners, the
  // cursor lock, and any queued frame). Set while dragging, null otherwise, so
  // the unmount effect can tear down a drag that's still active.
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Mirror the Y.Text content into React state so the preview re-renders as
  // the source changes (local or remote). The preview debounces compilation.
  useEffect(() => {
    if (!ytext) return;
    const update = () => setSource(ytext.toString());
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [ytext]);

  // Defensive: if the tab unmounts mid-drag, tear the drag down (removes the
  // orphaned document listeners, cancels the queued frame, and undoes the
  // global cursor/selection lock that mouseup would normally clear).
  useEffect(() => () => { dragCleanupRef.current?.(); }, []);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    // Cache the container geometry once: reading it per-mousemove forces a
    // synchronous layout (reflow) every event, which is a big part of the lag.
    const rect = container.getBoundingClientRect();
    pendingPctRef.current = editorPctRef.current;
    // Suppress text selection + lock the cursor for the whole drag.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    // Commit at most once per frame. State stays the source of truth (so a
    // remote edit re-rendering mid-drag can't desync the width), but rAF
    // coalesces a burst of mousemoves into a single render + layout per frame.
    const flush = () => {
      rafRef.current = 0;
      setEditorPct(pendingPctRef.current);
    };
    const onMove = (ev: MouseEvent) => {
      const pct = (ev.clientX - rect.left) / rect.width;
      pendingPctRef.current = Math.min(0.8, Math.max(0.2, pct));
      if (!rafRef.current) rafRef.current = requestAnimationFrame(flush);
    };
    // Removes the document listeners + cursor lock + queued frame. Callable
    // from both onUp (normal end) and the unmount effect (drag interrupted).
    const cleanup = () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      dragCleanupRef.current = null;
    };
    const onUp = () => {
      setEditorPct(pendingPctRef.current);
      cleanup();
    };
    dragCleanupRef.current = cleanup;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
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
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3">
        <div className="flex items-center gap-2">
          <FileText size={13} className="text-[hsl(var(--status-purple))]" />
          <span className="text-[11px] font-bold uppercase tracking-widest text-[hsl(var(--foreground))]">Typst</span>
          <span className="text-[10px] text-[hsl(var(--muted-foreground))]">locally rendered</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowEditor((v) => !v)}
            title={showEditor ? 'Hide code editor' : 'Show code editor'}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
          >
            {showEditor ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
            Code
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

      {/* Editor | Preview */}
      <div ref={containerRef} className="flex min-h-0 flex-1">
        {showEditor && (
          <>
            <div className="min-w-0 overflow-hidden border-r border-[hsl(var(--border))]" style={{ width: `${editorPct * 100}%`, contain: 'layout paint' }}>
              {ytext ? (
                <TypstEditor ytext={ytext} />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">Loading…</div>
              )}
            </div>
            <div
              onMouseDown={startResize}
              className="w-1 shrink-0 cursor-col-resize bg-[hsl(var(--border))] transition-colors hover:bg-[hsl(var(--primary))]"
            />
          </>
        )}
        <div className="min-w-0 flex-1 overflow-hidden" style={{ contain: 'layout paint' }}>
          <TypstPreview source={source} />
        </div>
      </div>
    </div>
  );
}
