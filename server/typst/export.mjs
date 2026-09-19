// Spawns the two CLIs. Everything here is async on purpose: the process also
// runs the Yjs relay, and a synchronous compile would freeze every editor
// (the concern behind invariant #9).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseDiagnostics } from './diagnostics.mjs';
import { createSerial } from './serial.mjs';
import { toPandocSource, pandocSourceWarnings } from './docx-source.mjs';
import { filterDocxImages } from './docx-ast.mjs';
import { stageReport, unstage, ExportError } from './stage.mjs';

export { ExportError };

const TIMEOUT_MS = 120_000;
const serial = createSerial();

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
      if (err && (err.killed || err.signal)) return resolve({ code: 124, stderr: `error: ${path.basename(cli)} timed out after 120 s` });
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr: String(stderr ?? '') });
    });
  });
}

// The 17 default faces the browser compiler uses, staged by scripts/fonts.ts.
const defaultFontDir = () => path.join(process.env.STATIC_DIR || path.resolve('..', 'dist'), 'fonts');

async function toPdf(root) {
  const cli = clis().typst;
  if (!cli) throw new ExportError(501, 'typst CLI not found on this server');
  const out = path.join(root, 'out.pdf');
  const args = ['compile', '--root', root, '--ignore-system-fonts', '--diagnostic-format', 'short', '--font-path', path.join(root, 'fonts')];
  if (fs.existsSync(defaultFontDir())) args.push('--font-path', defaultFontDir());
  args.push(path.join(root, 'main.typ'), out);
  const { code, stderr } = await run(cli, args, root);
  const diagnostics = parseDiagnostics(stderr, root);
  if (code !== 0 || diagnostics.some((d) => d.severity === 'error') || !fs.existsSync(out)) {
    const first = diagnostics.find((d) => d.severity === 'error');
    throw new ExportError(422, first ? `Typst error at ${first.file ?? '?'}:${first.line ?? '?'}: ${first.message}` : (stderr.trim() || 'the report did not compile'), diagnostics);
  }
  return new Uint8Array(fs.readFileSync(out));
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
    throw new ExportError(422, read.stderr.trim() || 'pandoc could not read the report');
  }
  let ast;
  try { ast = JSON.parse(fs.readFileSync(astFile, 'utf8')); }
  catch { throw new ExportError(422, 'pandoc produced a document this server could not read'); }

  const filtered = filterDocxImages(ast, (target) => stagedImageExists(root, target));
  fs.writeFileSync(astFile, JSON.stringify(filtered.ast));

  const write = await run(cli, ['ast.json', '-f', 'json', '-t', 'docx', '--resource-path', '.', '-o', 'out.docx'], root);
  const out = path.join(root, 'out.docx');
  if (write.code !== 0 || !fs.existsSync(out)) {
    throw new ExportError(422, write.stderr.trim() || 'pandoc could not convert the report');
  }
  return {
    bytes: new Uint8Array(fs.readFileSync(out)),
    warnings: [...filtered.warnings, ...pandocWarnings(read.stderr), ...pandocWarnings(write.stderr)],
  };
}

export function exportReport(workspaceId, format) {
  return serial(async () => {
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
      return { bytes: await toPdf(root), baked, warnings };
    } finally {
      unstage(root);
    }
  });
}
