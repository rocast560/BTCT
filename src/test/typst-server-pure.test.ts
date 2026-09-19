import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseDiagnostics, scrubPaths } from '../../server/typst/diagnostics.mjs';
import { createSerial } from '../../server/typst/serial.mjs';

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
});
