// ─────────────────────────────────────────────────────────────────────────
// The last good preview of each Typst document this session, so switching
// workspaces (or closing and reopening the Report tab) paints the pages that
// were on screen instead of an empty "Rendering…" panel while the wasm
// compiler spins up again.
//
// Bounded by characters of SVG rather than entries: one long report is a few
// megabytes of markup, and the app targets a 1 to 2 GB host, so the budget is
// the thing worth capping. A read moves the entry to the back; an insert that
// pushes the total over the budget evicts from the front.
// ─────────────────────────────────────────────────────────────────────────

import type { TypstDiagnostic } from './typst-compiler-types';

/** What the preview needs to restore a document exactly as it was left. */
export interface RenderSnapshot {
  svg: string;
  diagnostics: TypstDiagnostic[];
  scrollTop: number;
}

export interface Lru<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  deleteWhere(pred: (key: string) => boolean): void;
  readonly size: number;
  /** Sum of `sizeOf` over the entries. */
  readonly weight: number;
}

/**
 * Insertion-ordered LRU. A single entry larger than the budget is still kept:
 * it is the one being shown.
 */
export function createLru<T>(opts: { maxWeight: number; sizeOf: (v: T) => number }): Lru<T> {
  const map = new Map<string, T>();
  let weight = 0;
  return {
    get size() { return map.size; },
    get weight() { return weight; },
    get(key) {
      const v = map.get(key);
      if (v === undefined) return undefined;
      map.delete(key);
      map.set(key, v);
      return v;
    },
    set(key, value) {
      const prev = map.get(key);
      if (prev !== undefined) { weight -= opts.sizeOf(prev); map.delete(key); }
      map.set(key, value);
      weight += opts.sizeOf(value);
      for (const [k, v] of map) {
        if (weight <= opts.maxWeight || map.size <= 1) break;
        map.delete(k);
        weight -= opts.sizeOf(v);
      }
    },
    delete(key) {
      const v = map.get(key);
      if (v === undefined) return;
      map.delete(key);
      weight -= opts.sizeOf(v);
    },
    deleteWhere(pred) {
      for (const k of [...map.keys()]) if (pred(k)) this.delete(k);
    },
  };
}

/**
 * Two or three long reports' worth of SVG.
 *
 * Typst Studio budgeted 32 MB here, but it browses a whole disk of documents.
 * BTCT keeps one report per workspace and rarely has more than a couple open,
 * so a quarter of that buys the same "switch back and it is already there"
 * behaviour for a fraction of the resident set on a 1 to 2 GB box.
 */
export const RENDER_CACHE_MAX_CHARS = 8_000_000;

export const renderCache: Lru<RenderSnapshot> = createLru<RenderSnapshot>({
  maxWeight: RENDER_CACHE_MAX_CHARS,
  sizeOf: (s) => s.svg.length,
});

/** Tests only. */
export function clearRenderCache(): void {
  renderCache.deleteWhere(() => true);
}
