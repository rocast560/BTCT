// Source-level guard for invariant #17: the Typst tab stays unreachable from
// the entry bundle.
//
// The build-time check (`grep -l typst_ts_web_compiler dist/assets/index-*.js`
// must find nothing) only runs against a built dist, and it fails long after
// the import that broke it was written. This reads the source instead: from
// outside the two Typst folders, every mention of `components/typst` or
// `lib/typst-` has to be a type-only import, a dynamic `import(` (what
// `lazy()` compiles to), or a comment. A plain `import { … } from
// '@/lib/typst-compiler'` in a module the shell already loads would pull the
// chunk AND its 28 MB wasm asset into the entry graph.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');

/** Files that are allowed to reference Typst code directly. */
const EXEMPT_PREFIXES = ['components/typst/', 'lib/typst-', 'test/'];

const REFERENCE = /components\/typst|lib\/typst-/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function relative(file: string): string {
  return path.relative(SRC, file).split(path.sep).join('/');
}

/** A line that mentions Typst code but does not link it into this module. */
function isAllowed(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true;
  if (/\bimport\s+type\b/.test(line) || /\bexport\s+type\b/.test(line)) return true;
  if (/\bimport\s*\(/.test(line)) return true;
  return false;
}

describe('the Typst tab is unreachable from the entry bundle (invariant #17)', () => {
  const files = sourceFiles(SRC).filter((f) => {
    const rel = relative(f);
    return !EXEMPT_PREFIXES.some((p) => rel.startsWith(p));
  });

  it('scans a meaningful number of files', () => {
    // Cheap guard against the walk silently finding nothing (a moved src/,
    // a changed cwd) and the suite passing for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
  });

  it('references Typst code only through type imports, dynamic imports or comments', () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!REFERENCE.test(line)) return;
        if (isAllowed(line)) return;
        violations.push(`${relative(file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });
});
