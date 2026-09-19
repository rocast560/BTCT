// Spawns the two CLIs. Everything here is async on purpose: the process also
// runs the Yjs relay, and a synchronous compile would freeze every editor
// (the concern behind invariant #9).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseDiagnostics, scrubPaths, childFailureMessage } from './diagnostics.mjs';
import { createSerial } from './serial.mjs';
import { createAdmission } from './admission.mjs';
import { toPandocSource, pandocSourceWarnings } from './docx-source.mjs';
import { filterDocxImages } from './docx-ast.mjs';
import { findPackageSpec } from './package-spec.mjs';
import { stageReport, unstage, ExportError } from './stage.mjs';

export { ExportError };

// Not a real HTTP status: it says "the caller is gone", so the route knows
// there is nobody left to answer. Nginx uses 499 for the same thing.
export const CLIENT_GONE = 499;

const TIMEOUT_MS = 120_000;
// A PDF that reaches this size is a runaway loop, not a report, and the
// bytes sit in the response buffer of a process that also relays Yjs.
const MAX_OUTPUT_MB = 100;
const MAX_OUTPUT_BYTES = MAX_OUTPUT_MB * 1024 * 1024;
const serial = createSerial();
// One running plus one waiting. A third caller is told to come back rather
// than being parked on an open socket behind a two-minute compile.
const admission = createAdmission(2);

function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

// Resolving a CLI walks every PATH entry, so it is cached: the report tab
// asks for capabilities on every mount, and that must not turn into a few
// dozen stat calls per open. A minute is short enough that installing a CLI
// on a running server shows up without a restart.
const CLI_TTL_MS = 60_000;
let cliCache = null;

function clis() {
  const now = Date.now();
  if (cliCache && now - cliCache.at < CLI_TTL_MS) return cliCache;
  cliCache = {
    at: now,
    typst: process.env.TYPST_CLI || onPath('typst'),
    pandoc: process.env.PANDOC_CLI || onPath('pandoc'),
  };
  return cliCache;
}

export function capabilities() {
  const c = clis();
  return { pdf: !!c.typst, docx: !!c.pandoc };
}

// A child gets PATH and nothing else it does not need to start. The server's
// own environment holds AUTH_SECRET and the cmdlog and backup tokens, and
// neither CLI has any business reading them.
function childEnv() {
  const env = { PATH: process.env.PATH ?? '' };
  if (process.platform === 'win32') {
    // Windows binaries fail to start without these: SystemRoot resolves the
    // system DLLs, TEMP/TMP is where both CLIs write their scratch files.
    for (const key of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'PATHEXT']) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

// An argument array, never a shell string: a caption or a filename from the
// shared doc must never be parsed by a shell.
function run(cli, args, cwd) {
  return new Promise((resolve) => {
    execFile(cli, args, { cwd, env: childEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: TIMEOUT_MS, killSignal: 'SIGKILL' }, (err, _stdout, stderr) => {
      // `killed` and only `killed` means our own timeout fired. Measured on
      // Bun 1.3.11: a timeout kill sets killed true with signal SIGKILL,
      // while an ordinary failure sets killed false and a numeric code. A
      // signal with killed false is a death we did not cause, and its stderr
      // is the only clue to why, so it is never thrown away.
      if (err && err.killed) {
        return resolve({ code: 124, killed: true, signal: err.signal ?? null, stderr: `error: ${path.basename(cli)} timed out after ${TIMEOUT_MS / 1000} s` });
      }
      // The binary was on PATH when the capabilities cache was filled and is
      // gone now. That is not something the report did, so it is a 501 like
      // any other missing CLI, not a 422 with an empty message.
      if (err && err.code === 'ENOENT') return resolve({ code: 'ENOENT', killed: false, signal: null, stderr: '' });
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        killed: false,
        signal: err?.signal ?? null,
        stderr: String(stderr ?? ''),
      });
    });
  });
}

/** Turn a finished child into an error, or into nothing when it succeeded. */
function failed(result, cli, fallback, diagnostics) {
  if (result.code === 'ENOENT') return new ExportError(501, `${path.basename(cli)} is no longer installed on this server`);
  if (result.code !== 0) {
    // A stack overflow, an OOM kill or another signal death gets named;
    // anything else keeps the child's own stderr, which says more.
    const death = childFailureMessage(result, path.basename(cli, path.extname(cli)));
    return new ExportError(422, death ?? fallback, diagnostics);
  }
  return null;
}

/** The finished file, refused when it is too big to hand back. */
function readOutput(file, label) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_OUTPUT_BYTES) {
    throw new ExportError(422, `The exported ${label} is too large (${Math.round(stat.size / 1024 / 1024)} MB).`);
  }
  // A Buffer, which goes straight to res.end: no Uint8Array round trip and no
  // second copy of a 100 MB file.
  return fs.readFileSync(file);
}

// The 17 default faces the browser compiler uses, staged by scripts/fonts.ts.
const defaultFontDir = () => path.join(process.env.STATIC_DIR || path.resolve('..', 'dist'), 'fonts');

function assertNoPackages(source) {
  const spec = findPackageSpec(source);
  if (spec) {
    throw new ExportError(422, `This report imports or mentions a Typst package spec (${spec}). Packages are not available in server export; use the browser PDF export.`);
  }
}

async function toPdf(root, source) {
  const cli = clis().typst;
  if (!cli) throw new ExportError(501, 'typst CLI not found on this server');
  assertNoPackages(source);
  const out = path.join(root, 'out.pdf');
  const args = [
    'compile', '--root', root, '--ignore-system-fonts', '--diagnostic-format', 'short',
    // One core. The default is every core, and the other one is running the
    // Yjs relay for the whole team.
    '-j', '1',
    // Defence in depth behind assertNoPackages: anything that still asks for
    // a package writes it inside the staged directory, which is deleted with
    // the export, instead of into the user data directory where it would
    // outlive the request.
    '--package-path', path.join(root, 'packages'),
    '--package-cache-path', path.join(root, 'packages'),
    '--font-path', path.join(root, 'fonts'),
  ];
  if (fs.existsSync(defaultFontDir())) args.push('--font-path', defaultFontDir());
  args.push(path.join(root, 'main.typ'), out);
  const result = await run(cli, args, root);
  if (result.code === 'ENOENT') throw failed(result, cli);
  // `-j 1` puts layout on the main thread, whose stack is smaller than a
  // worker's, so a very large document aborts there while it compiles with
  // the default job count. Measured with typst 0.14.2 on Windows: 2000
  // sections and a 4.2 MB PDF are fine, 3000 sections overflow. That panic
  // is a plain non-zero exit here and a signal death on Linux, and
  // childFailureMessage knows both shapes.
  const death = childFailureMessage(result, 'typst');
  if (death) throw new ExportError(422, death);
  // Every string that can reach a response body loses the staged path first:
  // it sits under the OS temp directory, which names the account.
  const diagnostics = parseDiagnostics(result.stderr, root).map((d) => ({
    ...d,
    message: scrubPaths(d.message, root),
    file: d.file && path.isAbsolute(d.file) ? scrubPaths(d.file, root) : d.file,
  }));
  if (result.code !== 0 || diagnostics.some((d) => d.severity === 'error') || !fs.existsSync(out)) {
    const first = diagnostics.find((d) => d.severity === 'error');
    throw new ExportError(422, first
      ? `Typst error at ${first.file ?? '?'}:${first.line ?? '?'}: ${first.message}`
      : (scrubPaths(result.stderr, root).trim() || 'the report did not compile'), diagnostics);
  }
  return readOutput(out, 'PDF');
}

/** Is this AST target a regular file sitting directly in the staged assets directory? */
function stagedImageExists(root, target) {
  const assetsDir = path.resolve(root, 'assets');
  const file = path.resolve(assetsDir, path.basename(target));
  if (path.dirname(file) !== assetsDir) return false;
  try { return fs.lstatSync(file).isFile(); } catch { return false; }
}

/** pandoc's own `[WARNING] ...` lines, in the order it printed them. */
const pandocWarnings = (stderr) => String(stderr).split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.startsWith('[WARNING]'))
  .map((line) => line.replace(/^\[WARNING\]\s*/, ''));

/**
 * Typst to Word in two steps, with pandoc's reader sandboxed.
 *
 * One `-t docx` call cannot be made safe. Measured against pandoc 3.11:
 * `#raw(read("C:/Windows/win.ini"))` and `#include "../x"` put outside files
 * into word/document.xml, and `#let u = "http://host/x.png"; #image(u)` made
 * pandoc issue the GET, which is a request from inside whatever network this
 * box sits in. `--sandbox` stops all of that, and also stops the writer
 * reading the staged images, so the Word file came out with no pictures at
 * all.
 *
 * Splitting the run solves both halves:
 *   1. read to JSON WITH --sandbox: `read`, `include` and any fetch are
 *      refused by pandoc itself, and the report's own error comes back as a
 *      422;
 *   2. filter the AST in this process: every image target has been evaluated
 *      by now, so a concatenated or variable path is a plain string here, and
 *      anything that is not a staged file is replaced with a placeholder;
 *   3. write the filtered AST to .docx. This step is NOT sandboxed, because
 *      the sandbox would drop the images again (measured: 10546 bytes and no
 *      word/media, against 15152 with the pictures). It is fed nothing but
 *      targets step 2 confirmed are regular files inside the staged
 *      directory, so there is nothing left for it to reach.
 */
async function toDocx(root, source) {
  const cli = clis().pandoc;
  if (!cli) throw new ExportError(501, 'pandoc not found on this server');
  fs.writeFileSync(path.join(root, 'docx.typ'), toPandocSource(source));

  const read = await run(cli, ['docx.typ', '-f', 'typst', '-t', 'json', '--sandbox', '-o', 'ast.json'], root);
  const astFile = path.join(root, 'ast.json');
  if (read.code !== 0 || !fs.existsSync(astFile)) {
    // `failed` returns null for a clean exit, which happens here only when
    // pandoc reported success and wrote nothing.
    throw failed(read, cli, scrubPaths(read.stderr, root).trim() || 'pandoc could not read the report')
      ?? new ExportError(422, 'pandoc finished without producing a file.');
  }
  let ast;
  try { ast = JSON.parse(fs.readFileSync(astFile, 'utf8')); }
  catch { throw new ExportError(422, 'pandoc produced a document this server could not read'); }

  const filtered = filterDocxImages(ast, (target) => stagedImageExists(root, target));
  fs.writeFileSync(astFile, JSON.stringify(filtered.ast));

  const write = await run(cli, ['ast.json', '-f', 'json', '-t', 'docx', '--resource-path', '.', '-o', 'out.docx'], root);
  const out = path.join(root, 'out.docx');
  if (write.code !== 0 || !fs.existsSync(out)) {
    throw failed(write, cli, scrubPaths(write.stderr, root).trim() || 'pandoc could not convert the report')
      ?? new ExportError(422, 'pandoc finished without producing a file.');
  }
  return {
    bytes: readOutput(out, 'Word file'),
    warnings: [
      ...filtered.warnings,
      ...pandocWarnings(read.stderr).map((w) => scrubPaths(w, root)),
      ...pandocWarnings(write.stderr).map((w) => scrubPaths(w, root)),
    ],
  };
}

/**
 * @param isCancelled asked once, when this job reaches the front of the queue:
 *   true means the caller has gone and the work is not worth doing.
 */
export function exportReport(workspaceId, format, isCancelled = () => false) {
  if (!admission.enter()) {
    return Promise.reject(new ExportError(429, 'Another export is already queued. Try again in a moment.'));
  }
  return serial(async () => {
    if (isCancelled()) throw new ExportError(CLIENT_GONE, 'the caller disconnected before the export started');
    const { root, source, baked, warnings } = await stageReport(workspaceId);
    try {
      // A Word file that quietly lost a caption or a figure is worse than one
      // that says so: pandocSourceWarnings names every slot whose caption
      // could not be evaluated, and toDocx adds every image it dropped. PDF
      // goes through Typst itself, which evaluates everything.
      if (format === 'docx') {
        const docx = await toDocx(root, source);
        return { bytes: docx.bytes, baked, warnings: [...warnings, ...pandocSourceWarnings(source), ...docx.warnings] };
      }
      return { bytes: await toPdf(root, source), baked, warnings };
    } finally {
      unstage(root);
    }
  }).finally(() => admission.leave());
}
