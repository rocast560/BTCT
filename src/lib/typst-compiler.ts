// ─────────────────────────────────────────────────────────────────────────
// Local (in-browser) Typst compiler.
//
// Wraps @myriaddreamin/typst.ts so the Typst tab can render documents fully
// offline — no calls to typst.app or any remote service. The compiler +
// renderer WebAssembly modules are bundled with the app (imported via Vite's
// `?url` so they ship as static assets in the Docker image).
//
// The heavy typst.ts JS is loaded with a dynamic import the first time the
// Typst tab compiles, keeping it out of the initial app bundle. Compilation
// runs on a serialized queue because the compiler carries per-compilation
// state — interleaving two compiles would corrupt output.
//
// Why we build the compiler/renderer ourselves instead of using typst.ts's
// `$typst` singleton:
//
//  1. Custom fonts. Fonts can only be supplied at *init* time, through
//     `loadFonts`, which merges the operator's uploads with the default
//     asset set. Owning the instance lets us tear it down and rebuild it
//     when the workspace's font list changes — see `setTypstFonts`.
//  2. One filesystem root for both outputs. `$typst.pdf({mainContent})`
//     writes the source to `/tmp/<random>.typ`, while the preview compiled
//     at `/main.typ`. With no assets that difference was invisible; the
//     moment a document says `#image("/assets/x.png")` the two paths would
//     resolve differently and PDF export would break. Both now compile the
//     same file at the same root.
// ─────────────────────────────────────────────────────────────────────────

// `?url` yields the asset URL (a string); Vite emits the wasm as a hashed file
// and serves it locally. typst.ts fetches it lazily via `getModule`.
import compilerWasmUrl from '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url';
import rendererWasmUrl from '@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url';

/** A single Typst diagnostic (error/warning) from the compiler. */
export interface TypstDiagnostic {
  severity: string; // 'error' | 'warning' | …
  message: string;
  range?: string;
  path?: string;
}

export interface TypstSvgResult {
  svg?: string;
  diagnostics: TypstDiagnostic[];
  /**
   * True when a newer preview compile was requested before this one reached
   * the front of the queue, so it returned without doing any work. Callers
   * should ignore the result entirely rather than treating the absent `svg`
   * as "the document produced nothing".
   */
  superseded?: boolean;
}

/** A file mounted into the compiler's in-memory filesystem. */
export interface TypstShadowFile {
  /** Absolute virtual path, e.g. `/assets/screenshot.png`. */
  path: string;
  bytes: Uint8Array;
}

// Stable virtual path for the document inside the compiler's in-memory FS.
const MAIN_PATH = '/main.typ';

// typst.ts's `format` discriminator (see CompileFormatEnum).
const FORMAT_VECTOR = 0;
const FORMAT_PDF = 1;

// typst.ts has no exported types we depend on here; treat the instances as
// structurally `any` to avoid coupling to its (less-stable) public surface.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyCompiler = any;
type AnyRenderer = any;

interface TypstInstance {
  compiler: AnyCompiler;
  renderer: AnyRenderer;
  /** Which font generation this instance was built with. */
  fontGeneration: number;
}

// ── mutable inputs ───────────────────────────────────────────────────────
// Custom fonts and shadow files are set by the Typst tab (see
// components/typst/TypstView.tsx) whenever the workspace's assets change.

let customFonts: Uint8Array[] = [];
let fontGeneration = 0;

let shadowFiles: TypstShadowFile[] = [];
let shadowGeneration = 0;
let appliedShadowGeneration = -1;

let instancePromise: Promise<TypstInstance> | null = null;

// Monotonic id for preview compiles, used to drop superseded ones before they
// do any work. Export compiles (PDF/SVG download) deliberately don't
// participate — an explicit export must always run.
let svgRequestSeq = 0;

/**
 * Build the compiler + renderer with the current font set.
 *
 * `loadFonts(userFonts, { assets: ['text'] })` reproduces exactly what
 * typst.ts's driver installs by default (the `text` asset family) and adds
 * the operator's uploads on top — so adding a custom font never costs you
 * New Computer Modern and friends.
 */
async function buildInstance(): Promise<TypstInstance> {
  const generation = fontGeneration;
  const fonts = customFonts;
  const { createTypstCompiler, createTypstRenderer, loadFonts } = await import(
    '@myriaddreamin/typst.ts'
  );

  const compiler = createTypstCompiler();
  await compiler.init({
    getModule: () => compilerWasmUrl,
    beforeBuild: [loadFonts(fonts as unknown as Uint8Array[], { assets: ['text'] })],
  });

  const renderer = createTypstRenderer();
  await renderer.init({ getModule: () => rendererWasmUrl });

  // A fresh compiler has an empty shadow FS, so whatever we mapped into the
  // previous instance has to be re-applied on the next compile.
  appliedShadowGeneration = -1;

  return { compiler, renderer, fontGeneration: generation };
}

/**
 * Lazily build (and memoize) the compiler. Rebuilds transparently when the
 * font set has changed since the cached instance was created.
 */
async function getInstance(): Promise<TypstInstance> {
  if (instancePromise) {
    const inst = await instancePromise;
    if (inst.fontGeneration === fontGeneration) return inst;
    // Fonts changed — drop the stale instance and build a new one.
    instancePromise = null;
  }
  if (!instancePromise) {
    instancePromise = buildInstance();
    // If init throws (e.g. wasm failed to load), don't cache the rejection —
    // let the next attempt retry from scratch.
    instancePromise.catch(() => { instancePromise = null; });
  }
  return instancePromise;
}

// Serialize all compiler access: the compiler holds state across calls.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // Keep the chain alive even if a task rejects.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Replace the set of files mounted into the compiler's virtual filesystem.
 *
 * Callers pass the *final* bytes — an image with a crop rect has already
 * been cropped by `lib/typst-assets.ts`, so from Typst's point of view the
 * file simply is the cropped image.
 *
 * Cheap to call repeatedly: the bytes are only pushed into wasm when the set
 * actually changes, not on every keystroke-triggered recompile.
 *
 * Returns true if the set actually changed, so callers can skip forcing a
 * re-render when nothing did.
 */
export function setTypstShadowFiles(files: TypstShadowFile[]): boolean {
  const changed =
    files.length !== shadowFiles.length ||
    files.some((f, i) => {
      const prev = shadowFiles[i];
      return !prev || f.path !== prev.path || f.bytes !== prev.bytes;
    });
  if (!changed) return false;
  shadowFiles = files;
  shadowGeneration++;
  return true;
}

/**
 * Replace the set of custom fonts available to the compiler.
 *
 * Fonts can only be installed at init, so changing this discards the cached
 * compiler and the next compile rebuilds it (~1s; the wasm module itself is
 * already in the browser's module cache, so nothing is re-downloaded). Font
 * changes are rare — an operator drops in their client's brand font once per
 * engagement — so paying that on change rather than on every render is the
 * right trade.
 *
 * Returns true if the set actually changed.
 */
export function setTypstFonts(fonts: Uint8Array[]): boolean {
  const changed =
    fonts.length !== customFonts.length || fonts.some((f, i) => f !== customFonts[i]);
  if (!changed) return false;
  customFonts = fonts;
  fontGeneration++;
  return true;
}

/** Push the current shadow file set into the compiler if it's out of date. */
function syncShadowFiles(compiler: AnyCompiler): void {
  if (appliedShadowGeneration === shadowGeneration) return;
  // resetShadow clears every mapped file, so removals take effect too.
  compiler.resetShadow();
  for (const f of shadowFiles) {
    compiler.mapShadow(f.path, f.bytes);
  }
  appliedShadowGeneration = shadowGeneration;
}

/**
 * Read a font file's metadata (family name, style, …) using typst.ts's own
 * parser — so the family name we show the operator is the one the compiler
 * will actually match in `#set text(font: "…")`.
 */
export async function getFontInfo(bytes: Uint8Array): Promise<{ family: string } | null> {
  const { createTypstFontBuilder } = await import('@myriaddreamin/typst.ts');
  const fb = createTypstFontBuilder();
  await fb.init({ getModule: () => compilerWasmUrl });
  const info: any = await fb.getFontInfo(bytes);
  if (!info) return null;
  // The wasm returns a struct whose family field has varied across versions;
  // accept the known spellings rather than pinning to one.
  const family = info.family ?? info.family_name ?? info.familyName ?? null;
  return family ? { family: String(family) } : null;
}

/**
 * Compile Typst source to an SVG string, fully locally.
 *
 * Returns the rendered SVG plus any diagnostics. On a compile error there is
 * no SVG and `diagnostics` carries the errors (with source ranges). The
 * promise rejects only on an unexpected/internal failure (e.g. the wasm
 * couldn't be loaded at all).
 */
export function compileTypstSvg(
  source: string,
  opts: { coalesce?: boolean } = {},
): Promise<TypstSvgResult> {
  // Coalesce superseded previews. The preview already debounces typing, but a
  // document that takes longer to compile than the debounce window will still
  // queue up compiles whose output is discarded the moment they finish. Since
  // only the newest preview can ever be shown, an older one that hasn't
  // started yet should cost nothing rather than a full compile.
  //
  // Opt-in, because an *export* must never be skipped: it isn't superseded by
  // a preview that happens to be requested while it waits in the queue.
  const seq = opts.coalesce ? ++svgRequestSeq : -1;
  return enqueue(async () => {
    if (seq !== -1 && seq !== svgRequestSeq) return { diagnostics: [], superseded: true };

    const { compiler, renderer } = await getInstance();
    syncShadowFiles(compiler);
    // Map the latest source, then reset + compile (matches typst.ts's own
    // ordering in TypstSnippet.vector()).
    compiler.addSource(MAIN_PATH, source);
    await compiler.reset();
    const res = await compiler.compile({
      mainFilePath: MAIN_PATH,
      format: FORMAT_VECTOR,
      diagnostics: 'full',
    });
    const diagnostics: TypstDiagnostic[] = (res?.diagnostics ?? []) as TypstDiagnostic[];
    if (!res?.result) return { diagnostics };

    const svg: string = await renderer.runWithSession(async (session: unknown) => {
      renderer.manipulateData({ renderSession: session, action: 'reset', data: res.result });
      return renderer.renderSvg({ renderSession: session });
    });
    return { svg, diagnostics };
  });
}

/**
 * Compile Typst source to PDF bytes, fully locally. Throws (rejects) with a
 * readable message if the document has compile errors.
 *
 * Compiles the same `/main.typ` as the preview so relative paths — notably
 * `#image("/assets/…")` — resolve identically in both.
 */
export function compileTypstPdf(source: string): Promise<Uint8Array> {
  return enqueue(async () => {
    const { compiler } = await getInstance();
    syncShadowFiles(compiler);
    compiler.addSource(MAIN_PATH, source);
    await compiler.reset();
    const res = await compiler.compile({
      mainFilePath: MAIN_PATH,
      format: FORMAT_PDF,
      diagnostics: 'full',
    });
    if (!res?.result) {
      const first = (res?.diagnostics ?? []).find(
        (d: TypstDiagnostic) => d.severity === 'error',
      );
      throw new Error(
        first
          ? `Typst error: ${first.message}`
          : 'Typst document has errors — fix them before exporting a PDF.',
      );
    }
    return res.result as Uint8Array;
  });
}

/** Re-export so callers can resolve the message of a thrown error uniformly. */
export { toMessage as typstErrorMessage };
