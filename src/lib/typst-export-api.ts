// Client side of the server Typst export (server/typst/index.mjs).
//
// This module is Typst code for invariant #17's purposes (it is named
// `typst-export-api.ts`, matching the `lib/typst-` exemption), so it may only
// be imported from `src/components/typst/` or another `lib/typst-*` module,
// never from anything the entry bundle loads unconditionally.
import { API_URL, useAuthStore } from '@/auth/auth-store';

export interface ExportCapabilities { pdf: boolean; docx: boolean }

export interface ServerExportResult {
  blob: Blob;
  baked: number;
  warnings: string[];
}

function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** What the server can export. All false when the routes do not exist. */
export async function fetchExportCapabilities(): Promise<ExportCapabilities> {
  try {
    const res = await fetch(`${API_URL}/api/typst/capabilities`, { headers: authHeaders() });
    if (!res.ok) return { pdf: false, docx: false };
    const data = (await res.json()) as Partial<ExportCapabilities>;
    return { pdf: data.pdf === true, docx: data.docx === true };
  } catch {
    return { pdf: false, docx: false };
  }
}

/**
 * Decode the `X-Export-Warnings` header (see `server/typst/index.mjs`'s
 * `encodeWarnings`): `encodeURIComponent(JSON.stringify(string[]))`, or
 * absent when there is nothing to report.
 *
 * A header only ever comes from this server, but it still travels through a
 * proxy and a browser's header parser before it gets here, so a malformed
 * value (a broken percent-escape, valid JSON that is not a string array)
 * is swallowed rather than thrown: the export already succeeded, and losing
 * the warnings is far better than losing the download over them.
 */
function decodeWarningsHeader(header: string | null): string[] {
  if (!header) return [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(header));
    if (Array.isArray(parsed) && parsed.every((w) => typeof w === 'string')) return parsed;
    return [];
  } catch {
    return [];
  }
}

// The dialog that places a screenshot into a figure slot identifies it by
// caption and source line, not by this ordinal, so the ordinal is dropped
// for display and the line takes the lead instead.
const FIGURE_SLOT_WARNING = /^Figure slot \d+ \(line (\d+)\): (.*)$/;

/** Reword a server warning for the banner. Unrecognised text passes through. */
export function displayWarning(warning: string): string {
  const m = FIGURE_SLOT_WARNING.exec(warning);
  return m ? `Line ${m[1]}: ${m[2]}` : warning;
}

/**
 * The banner after a server export, or null when there is nothing to say.
 *
 * `X-Baked-Images` is the only thing that tells whoever clicked the button
 * that the crops and redactions really did go into the file they just
 * downloaded, so it leads. Warnings follow in the wording the tab already
 * used. Nothing baked and nothing to warn about stays silent, as before.
 */
export function serverExportNotice(baked: number, warnings: string[]): string | null {
  const redacted = baked > 0 ? `${baked} image(s) had their redactions baked in.` : null;
  if (warnings.length === 0) return redacted === null ? null : `Exported. ${redacted}`;
  return [
    ...(redacted === null ? [] : [redacted]),
    `Exported, with ${warnings.length} note(s):`,
    ...warnings.map(displayWarning),
  ].join('\n');
}

export async function exportOnServer(workspaceId: string, format: 'pdf' | 'docx'): Promise<ServerExportResult> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/typst/${encodeURIComponent(workspaceId)}/export?format=${format}`, {
      method: 'POST',
      headers: authHeaders(),
    });
  } catch {
    throw new Error('Could not reach the server.');
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `export failed (${res.status})`);
  }
  return {
    blob: await res.blob(),
    baked: Number(res.headers.get('X-Baked-Images') ?? 0),
    warnings: decodeWarningsHeader(res.headers.get('X-Export-Warnings')),
  };
}
