// ─────────────────────────────────────────────────────────────────────────
// Local (in-browser) Typst compiler.
//
// Wraps @myriaddreamin/typst.ts so the Typst tab can render documents fully
// offline — no calls to typst.app or any remote service. The compiler +
// renderer WebAssembly modules are bundled with the app (imported via Vite's
// `?url` so they ship as static assets in the Docker image), and the default
// Typst font set is embedded inside the 28 MB compiler wasm, so plain text
// renders without fetching any remote font assets. Suits an air-gapped LAN
// engagement.
//
// The heavy typst.ts JS is loaded with a dynamic import the first time the
// Typst tab compiles, keeping it out of the initial app bundle. Compilation
// runs on a serialized queue because the shared `$typst` instance carries
// per-compilation state — interleaving two compiles would corrupt output.
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
}

// Stable virtual path for the document inside the compiler's in-memory FS.
const MAIN_PATH = '/main.typ';

// typst.ts has no exported types we depend on here; treat the snippet as a
// structural any to avoid coupling to its (less-stable) public surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TypstSnippet = any;

let typstPromise: Promise<TypstSnippet> | null = null;

/**
 * Lazily load typst.ts and point it at the locally-bundled wasm. Memoized so
 * the wasm is initialized exactly once per session.
 */
async function getTypst(): Promise<TypstSnippet> {
  if (typstPromise) return typstPromise;
  typstPromise = (async () => {
    const { $typst } = await import('@myriaddreamin/typst.ts');
    // Must be set before the first getCompiler()/getRenderer() builds them.
    $typst.setCompilerInitOptions({ getModule: () => compilerWasmUrl });
    $typst.setRendererInitOptions({ getModule: () => rendererWasmUrl });
    return $typst;
  })();
  // If init throws (e.g. wasm failed to load), don't cache the rejection —
  // let the next attempt retry from scratch.
  typstPromise.catch(() => { typstPromise = null; });
  return typstPromise;
}

// Serialize all compiler access: the shared $typst holds state across calls.
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
 * Compile Typst source to an SVG string, fully locally.
 *
 * Returns the rendered SVG plus any diagnostics. On a compile error there is
 * no SVG and `diagnostics` carries the errors (with source ranges). The
 * promise rejects only on an unexpected/internal failure (e.g. the wasm
 * couldn't be loaded at all).
 */
export function compileTypstSvg(source: string): Promise<TypstSvgResult> {
  return enqueue(async () => {
    const $typst = await getTypst();
    const compiler = await $typst.getCompiler();
    // Map the latest source, then reset + compile (matches typst.ts's own
    // ordering in TypstSnippet.vector()).
    compiler.addSource(MAIN_PATH, source);
    await compiler.reset();
    const res = await compiler.compile({ mainFilePath: MAIN_PATH, diagnostics: 'full' });
    const diagnostics: TypstDiagnostic[] = (res?.diagnostics ?? []) as TypstDiagnostic[];
    if (!res?.result) return { diagnostics };

    const renderer = await $typst.getRenderer();
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
 */
export function compileTypstPdf(source: string): Promise<Uint8Array> {
  return enqueue(async () => {
    const $typst = await getTypst();
    const bytes: Uint8Array | undefined = await $typst.pdf({ mainContent: source });
    if (!bytes) throw new Error('Typst document has errors — fix them before exporting a PDF.');
    return bytes;
  });
}

/** Re-export so callers can resolve the message of a thrown error uniformly. */
export { toMessage as typstErrorMessage };
