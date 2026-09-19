// Parses `typst compile --diagnostic-format short` stderr. Pure: no fs, no
// spawn, so src/test covers it through the .d.mts beside this file.
import path from 'node:path';

const LINE = /^(?:\\\\\?\\)?(.+?):(\d+):(\d+): (error|warning): (.*)$/;

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
