// Type surface of backup-format.mjs for the TypeScript side (tests + tsc).
// Keep in sync with the .mjs; the runtime has no build step.

export interface BackupIncludes {
  sqlite: boolean;
  yjsShared: boolean;
  yjsPages: boolean;
  assets: boolean;
  history: boolean;
}

export interface BackupConfig {
  enabled: boolean;
  fullIntervalMin: number;
  includes: BackupIncludes;
}

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ManifestDoc {
  name: string;
  bytes: number;
  stateVector: string;
}

export interface ManifestAsset {
  id: string;
  filename?: string;
  mime?: string;
  size?: number;
  workspaceId?: string;
  kind?: string;
  present?: boolean;
}

export interface ManifestHistory {
  pageId: string;
  bytes: number;
}

export interface BackupManifest {
  schemaVersion: number;
  format: 'btct-backup';
  instanceId: string;
  createdAt: string;
  trigger: string;
  app: Record<string, unknown>;
  includes: BackupIncludes;
  sqlite: { dataVersion?: number; rawBytes?: number } | null;
  docs: ManifestDoc[];
  assets: ManifestAsset[];
  files: ManifestFile[];
  totalBytes: number;
}

export const BACKUP_SCHEMA_VERSION: number;
export const BACKUP_NAME_PREFIX: string;
export const MANIFEST_FILE: string;
export const FULL_INTERVAL_MIN_FLOOR: number;
export const FULL_INTERVAL_MIN_CEIL: number;
export const FULL_INTERVAL_MIN_DEFAULT: number;
export const INCLUDE_KEYS: readonly string[];
export const DEFAULT_BACKUP_CONFIG: Readonly<BackupConfig>;

export function normalizeIncludes(raw: unknown): BackupIncludes;
export function normalizeBackupConfig(raw: unknown): BackupConfig;
export function backupName(date?: Date): string;
export function isBackupName(name: unknown): boolean;
export function backupNameTime(name: string): number | null;
export function sha256File(absPath: string): Promise<string>;
export function buildManifest(input: {
  instanceId: string;
  createdAt?: string;
  trigger?: string;
  includes: Partial<BackupIncludes> | BackupIncludes;
  files: ManifestFile[];
  docs?: ManifestDoc[];
  sqlite?: { dataVersion?: number; rawBytes?: number } | null;
  assets?: ManifestAsset[];
  app?: Record<string, unknown>;
}): BackupManifest;
export function readManifest(dir: string): { manifest: BackupManifest; error?: undefined } | { error: string; manifest?: undefined };
export function verifyBackupDir(dir: string): Promise<{ ok: boolean; errors: string[]; manifest: BackupManifest | null }>;
export function formatBytes(n: number): string;
