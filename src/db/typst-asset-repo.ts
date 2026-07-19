/**
 * Repo for Typst asset *metadata*. The bytes are never touched here — they
 * live on the server and are fetched/cached by `lib/typst-assets.ts`.
 *
 * Unlike most repos in this directory there are no Y.Text fields to pre-seed.
 * A filename and a crop rectangle are not prose: two people typing into the
 * same filename simultaneously is not a workflow worth supporting, so these
 * stay plain last-writer-wins JSON records and the Y.Text invariant doesn't
 * apply. (See CLAUDE.md "Critical invariants" #1.)
 */
import { db } from './database';
import type { CropRect, ID, TypstAsset, TypstAssetKind } from '@/types';

export const typstAssetRepo = {
  async getByWorkspace(workspaceId: ID): Promise<TypstAsset[]> {
    const all = await db.typstAssets.where('workspaceId').equals(workspaceId).toArray();
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },

  async getById(id: ID): Promise<TypstAsset | undefined> {
    return db.typstAssets.get(id);
  },

  /**
   * Record an asset that the server has already accepted. `id` comes from
   * the upload response so the record and the blob always agree — we never
   * mint an id client-side for something the server is storing.
   */
  async create(data: {
    id: ID;
    workspaceId: ID;
    kind: TypstAssetKind;
    filename: string;
    mime: string;
    size: number;
    width?: number | null;
    height?: number | null;
    fontFamily?: string | null;
  }): Promise<TypstAsset> {
    const now = Date.now();
    const asset: TypstAsset = {
      id: data.id,
      workspaceId: data.workspaceId,
      kind: data.kind,
      filename: data.filename,
      mime: data.mime,
      size: data.size,
      width: data.width ?? null,
      height: data.height ?? null,
      crop: null,
      fontFamily: data.fontFamily ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await db.typstAssets.add(asset);
    return asset;
  },

  /** Set (or clear, with null) the render-time crop rectangle. */
  async setCrop(id: ID, crop: CropRect | null): Promise<void> {
    await db.typstAssets.update(id, { crop, updatedAt: Date.now() });
  },

  async rename(id: ID, filename: string): Promise<void> {
    await db.typstAssets.update(id, { filename, updatedAt: Date.now() });
  },

  async remove(id: ID): Promise<void> {
    await db.typstAssets.delete(id);
  },

  /**
   * True if `filename` is already taken in this workspace by a different
   * asset. Two assets sharing a name would collide in the Typst virtual FS,
   * with the second silently shadowing the first.
   */
  async filenameTaken(workspaceId: ID, filename: string, exceptId?: ID): Promise<boolean> {
    const all = await this.getByWorkspace(workspaceId);
    const target = filename.toLowerCase();
    return all.some((a) => a.id !== exceptId && a.filename.toLowerCase() === target);
  },

  /**
   * Append `-2`, `-3`, … to `filename` until it's free in this workspace.
   * Called before create so dropping two screenshots both named
   * `Screenshot.png` yields `Screenshot.png` and `Screenshot-2.png` rather
   * than one overwriting the other's VFS slot.
   */
  async uniqueFilename(workspaceId: ID, filename: string): Promise<string> {
    if (!(await this.filenameTaken(workspaceId, filename))) return filename;
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    for (let n = 2; n < 1000; n++) {
      const candidate = `${stem}-${n}${ext}`;
      if (!(await this.filenameTaken(workspaceId, candidate))) return candidate;
    }
    return `${stem}-${Date.now()}${ext}`;
  },
};
