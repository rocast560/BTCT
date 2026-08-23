import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_BACKUP_CONFIG,
  FULL_INTERVAL_MIN_FLOOR,
  FULL_INTERVAL_MIN_CEIL,
  normalizeIncludes,
  normalizeBackupConfig,
  backupName,
  isBackupName,
  buildManifest,
  verifyBackupDir,
  sha256File,
  formatBytes,
} from '../../server/backup-format.mjs';

describe('normalizeIncludes', () => {
  it('defaults every category to true', () => {
    expect(normalizeIncludes(undefined)).toEqual({ sqlite: true, yjsShared: true, yjsPages: true, assets: true });
    expect(normalizeIncludes(null)).toEqual({ sqlite: true, yjsShared: true, yjsPages: true, assets: true });
  });

  it('keeps explicit booleans and ignores anything else', () => {
    expect(normalizeIncludes({ sqlite: false, assets: 'no', extra: true })).toEqual({
      sqlite: false, yjsShared: true, yjsPages: true, assets: true,
    });
  });
});

describe('normalizeBackupConfig', () => {
  it('has sane defaults', () => {
    expect(normalizeBackupConfig(undefined)).toEqual(DEFAULT_BACKUP_CONFIG);
    expect(DEFAULT_BACKUP_CONFIG.enabled).toBe(false);
    expect(DEFAULT_BACKUP_CONFIG.fullIntervalMin).toBe(60);
  });

  it('accepts the string forms the settings table stores', () => {
    const c = normalizeBackupConfig({ enabled: '1', fullIntervalMin: '15', includes: '{"assets":false}' });
    expect(c.enabled).toBe(true);
    expect(c.fullIntervalMin).toBe(15);
    expect(c.includes.assets).toBe(false);
  });

  it('clamps the interval to the floor and ceiling and falls back on garbage', () => {
    expect(normalizeBackupConfig({ fullIntervalMin: 0 }).fullIntervalMin).toBe(FULL_INTERVAL_MIN_FLOOR);
    expect(normalizeBackupConfig({ fullIntervalMin: -5 }).fullIntervalMin).toBe(FULL_INTERVAL_MIN_FLOOR);
    expect(normalizeBackupConfig({ fullIntervalMin: 1e9 }).fullIntervalMin).toBe(FULL_INTERVAL_MIN_CEIL);
    expect(normalizeBackupConfig({ fullIntervalMin: 'abc' }).fullIntervalMin).toBe(60);
    expect(normalizeBackupConfig({ fullIntervalMin: 2.7 }).fullIntervalMin).toBe(2);
  });
});

describe('backup names', () => {
  it('formats a UTC timestamp and round-trips through isBackupName', () => {
    const name = backupName(new Date(Date.UTC(2026, 7, 23, 10, 15, 0)));
    expect(name).toBe('btct-backup-20260823-101500');
    expect(isBackupName(name)).toBe(true);
  });

  it('rejects anything that is not a plain backup directory name', () => {
    for (const bad of ['../x', 'btct-backup-2026', 'btct-backup-20260823-101500.tmp', 'btct-backup-20260823-101500/..', '']) {
      expect(isBackupName(bad)).toBe(false);
    }
  });
});

describe('manifest round trip', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'btct-bk-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  async function makeBackup(dir: string) {
    fs.mkdirSync(path.join(dir, 'yjs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'yjs', 'btct-shared.yupdate.gz'), Buffer.from('hello'));
    fs.writeFileSync(path.join(dir, 'data.sqlite.gz'), Buffer.from('world'));
    const files = [];
    for (const rel of ['yjs/btct-shared.yupdate.gz', 'data.sqlite.gz']) {
      const abs = path.join(dir, rel);
      files.push({ path: rel, bytes: fs.statSync(abs).size, sha256: await sha256File(abs) });
    }
    const manifest = buildManifest({
      instanceId: 'inst-1',
      createdAt: '2026-08-23T10:15:00.000Z',
      trigger: 'manual',
      includes: normalizeIncludes({ assets: false }),
      files,
      docs: [{ name: 'btct-shared', bytes: 5, stateVector: 'AA==' }],
      sqlite: { dataVersion: 7, rawBytes: 4096 },
      app: { version: '0.5.0' },
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  it('verifies a backup whose files match the manifest', async () => {
    const dir = tmp();
    const m = await makeBackup(dir);
    expect(m.schemaVersion).toBe(1);
    expect(m.files.length).toBe(2);
    const v = await verifyBackupDir(dir);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.manifest?.instanceId).toBe('inst-1');
  });

  it('reports a tampered or missing file by path', async () => {
    const dir = tmp();
    await makeBackup(dir);
    fs.writeFileSync(path.join(dir, 'data.sqlite.gz'), Buffer.from('w0rld'));
    fs.unlinkSync(path.join(dir, 'yjs', 'btct-shared.yupdate.gz'));
    const v = await verifyBackupDir(dir);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('data.sqlite.gz'))).toBe(true);
    expect(v.errors.some((e) => e.includes('btct-shared.yupdate.gz'))).toBe(true);
  });

  it('fails cleanly without a manifest', async () => {
    const dir = tmp();
    const v = await verifyBackupDir(dir);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/manifest/i);
  });
});

describe('formatBytes', () => {
  it('picks a readable unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});
