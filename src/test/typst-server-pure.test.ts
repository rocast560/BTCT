import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseDiagnostics, scrubPaths, childFailureMessage } from '../../server/typst/diagnostics.mjs';
import { createSerial } from '../../server/typst/serial.mjs';
import { findPackageSpec } from '../../server/typst/package-spec.mjs';
import { referencedAssetNames } from '../../server/typst/referenced-assets.mjs';

describe('parseDiagnostics', () => {
  it('reads file:line:col lines relative to the root', () => {
    const root = path.resolve('/tmp/x');
    const file = path.join(root, 'main.typ');
    const out = parseDiagnostics(`${file}:12:3: error: unknown variable: foo\n`, root);
    expect(out).toEqual([{ severity: 'error', message: 'unknown variable: foo', file: 'main.typ', line: 12, col: 3 }]);
  });
  it('reads bare error lines and skips noise', () => {
    const out = parseDiagnostics('\nwarning: layout did not converge\nsome noise\n', '/tmp/x');
    expect(out).toEqual([{ severity: 'warning', message: 'layout did not converge', file: null, line: null, col: null }]);
  });
});

describe('createSerial', () => {
  it('never overlaps jobs and keeps order', async () => {
    const run = createSerial();
    const log: string[] = [];
    const job = (n: string, ms: number) => run(async () => { log.push(`start ${n}`); await new Promise((r) => setTimeout(r, ms)); log.push(`end ${n}`); return n; });
    const results = await Promise.all([job('a', 20), job('b', 1)]);
    expect(results).toEqual(['a', 'b']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });
  it('keeps running after a job rejects', async () => {
    const run = createSerial();
    await expect(run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('scrubPaths', () => {
  // A compiler message quotes the path it tried, and the staged directory
  // sits under the OS temp folder, which on Windows names the account.
  const root = path.resolve('/tmp/btct-typst-AbCdEf');

  it('removes the staged root in its native form', () => {
    // path.join('.', ...) would normalize the dot away, so the expectation
    // spells the separator out.
    expect(scrubPaths(`file not found (searched at ${path.join(root, 'Windows', 'win.ini')})`, root))
      .toBe(`file not found (searched at .${path.sep}Windows${path.sep}win.ini)`);
  });

  it('removes it in the other separator flavour too', () => {
    const forward = root.split(path.sep).join('/');
    const back = root.split(path.sep).join('\\');
    expect(scrubPaths(`at ${forward}/main.typ`, root)).toBe('at ./main.typ');
    expect(scrubPaths(`at ${back}\\main.typ`, root)).toBe('at .\\main.typ');
  });

  it('removes the Windows extended-length prefix with it', () => {
    const back = root.split(path.sep).join('\\');
    expect(scrubPaths(`searched at \\\\?\\${back}\\x`, root)).toBe('searched at .\\x');
  });

  it('ignores case on Windows, where paths are case insensitive', () => {
    if (process.platform !== 'win32') return;
    const shouty = root.split(path.sep).join('\\').toUpperCase();
    expect(scrubPaths(`at ${shouty}\\MAIN.TYP`, root)).toBe('at .\\MAIN.TYP');
  });

  it('leaves text that does not mention the root alone', () => {
    expect(scrubPaths('unknown variable: nope', root)).toBe('unknown variable: nope');
    expect(scrubPaths('', root)).toBe('');
  });

  it('is safe with a missing root or a non-string message', () => {
    expect(scrubPaths('x', '')).toBe('x');
    expect(scrubPaths(undefined as unknown as string, root)).toBe('');
  });

  it('removes every occurrence, not just the first', () => {
    const forward = root.split(path.sep).join('/');
    expect(scrubPaths(`${forward}/a and ${forward}/b`, root)).toBe('./a and ./b');
  });

  it('removes any path carrying the staging marker, whatever the spelling', () => {
    // Windows quotes 8.3 short paths in some messages, and then no part of
    // the directory we were given matches character for character. The
    // marker and the six characters mkdtemp appends are still there.
    expect(scrubPaths('file not found (searched at C:\\Users\\ROBER~1\\AppData\\Local\\Temp\\btct-typst-Qr8I8L\\assets\\x.png)', root))
      .toBe('file not found (searched at .)');
    expect(scrubPaths('could not read "/var/tmp/btct-typst-VmfxLw/main.typ"', root))
      .toBe('could not read "."');
    expect(scrubPaths('nothing to see here', root)).toBe('nothing to see here');
  });
});

describe('childFailureMessage', () => {
  // The shapes are what Bun hands execFile's callback. Verified on this
  // machine: a timeout kill sets killed true, signal SIGKILL, code null; an
  // ordinary failure sets killed false, signal null and a numeric code.
  // A Linux stack overflow or an OOM kill is a signal death we did not
  // cause, which is the case this function exists for.
  it('says nothing about a child we killed ourselves', () => {
    expect(childFailureMessage({ code: 124, killed: true, signal: 'SIGKILL', stderr: '' }, 'typst')).toBeNull();
  });

  it('says nothing about an ordinary non-zero exit', () => {
    expect(childFailureMessage({ code: 1, killed: false, signal: null, stderr: 'error: unknown variable' }, 'typst')).toBeNull();
    expect(childFailureMessage({ code: 0, killed: false, signal: null, stderr: '' }, 'typst')).toBeNull();
  });

  it('recognises a stack overflow however the process died', () => {
    const sentence = 'This report is too large for the server compiler. Export the PDF from the browser instead.';
    // Windows: a plain non-zero exit with the panic on stderr.
    expect(childFailureMessage({ code: 1, killed: false, signal: null, stderr: "\nthread 'main' has overflowed its stack\n" }, 'typst')).toBe(sentence);
    // Linux: the same panic, delivered as a signal.
    expect(childFailureMessage({ code: 1, killed: false, signal: 'SIGABRT', stderr: "thread 'main' has overflowed its stack" }, 'typst')).toBe(sentence);
    expect(childFailureMessage({ code: 1, killed: false, signal: 'SIGSEGV', stderr: 'thread MAIN has OVERFLOWED ITS STACK' }, 'typst')).toBe(sentence);
  });

  it('reads a SIGKILL we did not send as the memory killer', () => {
    expect(childFailureMessage({ code: 1, killed: false, signal: 'SIGKILL', stderr: '' }, 'typst'))
      .toBe('The export ran out of memory on the server. Export the PDF from the browser instead.');
  });

  it('names any other signal, with the tool that died', () => {
    expect(childFailureMessage({ code: 1, killed: false, signal: 'SIGSEGV', stderr: '' }, 'pandoc'))
      .toBe('The exporter stopped unexpectedly (pandoc, SIGSEGV).');
  });

  it('survives a result with missing fields', () => {
    expect(childFailureMessage({}, 'typst')).toBeNull();
    expect(childFailureMessage(null, 'typst')).toBeNull();
  });
});

describe('findPackageSpec', () => {
  // A package import makes the typst CLI fetch from packages.typst.org, from
  // the host the relay runs on. The match is on the quoted spec anywhere in
  // the source, not on an #import statement, because there are several ways
  // to hand the same string to the same loader.
  it('finds the plain import', () => {
    expect(findPackageSpec('#import "@preview/cetz:0.2.2": canvas\n= Report\n')).toBe('@preview/cetz:0.2.2');
    expect(findPackageSpec('#include "@local/house-style:1.0"')).toBe('@local/house-style:1.0');
  });

  it('finds the forms that route around an #import check', () => {
    expect(findPackageSpec('#let p = "@preview/cetz:0.2.2"\n#import p: canvas')).toBe('@preview/cetz:0.2.2');
    expect(findPackageSpec('#{ import "@preview/cetz:0.2.2": canvas }')).toBe('@preview/cetz:0.2.2');
    expect(findPackageSpec('#import("@preview/cetz:0.2.2")')).toBe('@preview/cetz:0.2.2');
    expect(findPackageSpec('#let specs = ("@preview/tablex:0.0.8",)\n#import specs.at(0)')).toBe('@preview/tablex:0.0.8');
  });

  it('leaves an ordinary report alone', () => {
    expect(findPackageSpec('= Findings\n#image("/assets/shot.png")\n#link("https://example.com")[x]\n')).toBeNull();
    expect(findPackageSpec('An email address like me@preview.example is not a package.')).toBeNull();
    expect(findPackageSpec('#import "helpers.typ": thing')).toBeNull();
    expect(findPackageSpec('')).toBeNull();
  });

  it('also catches a spec that is only quoted in prose, which is the accepted cost', () => {
    expect(findPackageSpec('We could not use "@preview/cetz:0.2.2" for this engagement.')).toBe('@preview/cetz:0.2.2');
  });

  it('will not run away on a long or multiline string', () => {
    expect(findPackageSpec(`#let x = "@preview/${'a'.repeat(200)}"`)).toBeNull();
    expect(findPackageSpec('#let x = "@preview/broken\nstill open"')).toBeNull();
  });
});

describe('referencedAssetNames', () => {
  // Staging every image in the workspace would cost a copy per unplaced
  // screenshot on every export, so only the names the report actually
  // mentions are staged. Over-inclusion is harmless (one extra file in a
  // directory that is deleted with the export); under-inclusion shows up as
  // a Typst "file not found" against the line that placed the image.
  const names = (source: string) => [...referencedAssetNames(source)].sort();

  it('finds a slot path and a hand-written image call', () => {
    const src = '#image-placeholder("Login", path: "/assets/login.png")\n#image("/assets/shell.png", width: 50%)\n';
    expect(names(src)).toEqual(['login.png', 'shell.png']);
  });

  it('finds a name with spaces in it', () => {
    expect(names('#image("/assets/my first shot.png")')).toEqual(['my first shot.png']);
  });

  it('lists a name referenced twice only once', () => {
    expect(names('#image("/assets/a.png")\n#image("/assets/a.png")\n')).toEqual(['a.png']);
  });

  it('matches a subfolder path by its basename, which stages the file flat', () => {
    // Typst would then fail to resolve /assets/sub/x.png, because staging is
    // flat. Staging the file anyway costs one copy and keeps the failure a
    // plain Typst diagnostic rather than a silent skip.
    expect(names('#image("/assets/sub/x.png")')).toEqual(['x.png']);
  });

  it('finds nothing in a bare /assets/ with no filename', () => {
    expect(names('The prefix is "/assets/" and nothing follows it.')).toEqual([]);
    expect(names('')).toEqual([]);
  });

  it('does not find a name whose string literal escapes a quote', () => {
    // The escape ends the match, so the file is not staged and Typst reports
    // the unresolved path. A filename carrying a double quote is the one
    // shape this scan gives up on, and it is the safe direction to fail.
    expect(names('#image("/assets/od\\"d.png")')).toEqual([]);
  });

  it('matches inside a comment or a raw block, which is accepted over-inclusion', () => {
    expect(names('// #image("/assets/old.png")')).toEqual(['old.png']);
    expect(names('```\n#image("/assets/sample.png")\n```')).toEqual(['sample.png']);
  });
});
