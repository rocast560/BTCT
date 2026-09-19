import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseDiagnostics } from '../../server/typst/diagnostics.mjs';
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
