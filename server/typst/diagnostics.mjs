// Parses `typst compile --diagnostic-format short` stderr. Pure: no fs, no
// spawn, so src/test covers it through the .d.mts beside this file.
import path from 'node:path';

const LINE = /^(?:\\\\\?\\)?(.+?):(\d+):(\d+): (error|warning): (.*)$/;

/**
 * Replace every mention of the staged directory with `.`.
 *
 * A compiler quotes the path it tried, and the staged directory sits under
 * the OS temp folder, which on Windows carries the account name. The caller
 * runs this over diagnostic messages, over a `file` that stayed absolute, and
 * over the raw stderr it falls back to, so none of that reaches a response
 * body. Every form the two CLIs print is covered: either separator, and the
 * Windows extended-length `\\?\` prefix, matched without regard to case on
 * Windows because its paths are case insensitive.
 */
export function scrubPaths(text, root) {
  const out = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (!out || !root) return out;
  const resolved = path.resolve(root).replace(/^\\\\\?\\/, '');
  const forms = [];
  for (const body of new Set([resolved, resolved.replace(/\\/g, '/'), resolved.replace(/\//g, '\\')])) {
    if (body) forms.push(`\\\\?\\${body}`, body); // the prefixed form first, or it would leave the prefix behind
  }
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  return forms.reduce((acc, form) => acc.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags), '.'), out);
}

/**
 * What to tell the operator when a child process died rather than failed.
 *
 * A Rust main-thread stack overflow and a cgroup OOM kill both end the
 * process by signal on Linux, and both arrive here looking like any other
 * non-zero exit. Saying "timed out after 120 s" three seconds into the
 * request, which is what a blanket signal check did, sends whoever reads the
 * message hunting for a slow compile that never happened.
 *
 * Returns null when there is nothing special to say: the child exited
 * normally with a non-zero status (its own stderr is the better message), or
 * the timeout killed it, which the caller already knows about because it
 * asked for it.
 *
 * Pure, so src/test can cover the cases this Windows box cannot produce.
 */
export function childFailureMessage(result, tool) {
  if (!result || result.killed) return null;
  const stderr = String(result.stderr ?? '');
  // Checked before the signal, because the same panic is a plain non-zero
  // exit on Windows and a signal death on Linux.
  if (/overflowed its stack/i.test(stderr)) {
    return 'This report is too large for the server compiler. Export the PDF from the browser instead.';
  }
  if (!result.signal) return null;
  if (result.signal === 'SIGKILL') {
    return 'The export ran out of memory on the server. Export the PDF from the browser instead.';
  }
  return `The exporter stopped unexpectedly (${tool}, ${result.signal}).`;
}

export function parseDiagnostics(stderr, root) {
  const out = [];
  const rootAbs = path.resolve(root).replace(/^\\\\\?\\/, '');
  for (const raw of String(stderr).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (m) {
      const abs = m[1].replace(/^\\\\\?\\/, '');
      const rel = path.isAbsolute(abs) ? path.relative(rootAbs, abs).split(path.sep).join('/') : abs.replace(/\\/g, '/');
      out.push({ severity: m[4], message: m[5], file: rel.startsWith('..') ? abs : rel, line: Number(m[2]), col: Number(m[3]) });
      continue;
    }
    const plain = /^(error|warning): (.*)$/.exec(line);
    if (plain) out.push({ severity: plain[1], message: plain[2], file: null, line: null, col: null });
  }
  return out;
}
