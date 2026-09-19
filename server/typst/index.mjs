// HTTP surface of the Typst server side. index.mjs imports this file
// dynamically, and only when ENABLE_TYPST is on.
import { capabilities, exportReport, ExportError } from './export.mjs';

const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

// The id names a room in the shared doc and, through stageReport, nothing on
// disk, but it still reaches a Y.Map lookup and an error message: keep it to
// the shape the client's ids actually have.
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// An HTTP header has a size limit and warnings come from report content, so
// they are capped twice over: at most this many, and short enough that the
// whole encoded value cannot push the response head over a proxy's limit.
const MAX_WARNINGS = 10;
const MAX_WARNING_CHARS = 4000;

/** The `X-Export-Warnings` value, or '' when there is nothing to send. */
export function encodeWarnings(warnings) {
  let list = (warnings ?? []).slice(0, MAX_WARNINGS);
  while (list.length > 0) {
    const encoded = encodeURIComponent(JSON.stringify(list));
    if (encoded.length <= MAX_WARNING_CHARS) return encoded;
    list = list.slice(0, list.length - 1);
  }
  return '';
}

// Returns true when it handled the request.
export async function handleTypst(req, res, { user, sendJson }) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/typst/')) return false;
  // BTCT has no per-workspace ACL: every authenticated account can already
  // read every workspace through the shared doc, so a valid account token is
  // the whole authorization check, exactly as for /api/assets.
  if (!user) { sendJson(res, 401, { error: 'unauthorised' }); return true; }

  if (req.method === 'GET' && url.pathname === '/api/typst/capabilities') {
    sendJson(res, 200, capabilities());
    return true;
  }

  const m = /^\/api\/typst\/([^/]+)\/export$/.exec(url.pathname);
  if (req.method === 'POST' && m) {
    const format = url.searchParams.get('format');
    if (format !== 'pdf' && format !== 'docx') { sendJson(res, 400, { error: 'format must be pdf or docx' }); return true; }
    let workspaceId;
    try { workspaceId = decodeURIComponent(m[1]); } catch { workspaceId = m[1]; }
    if (!WORKSPACE_ID.test(workspaceId)) { sendJson(res, 400, { error: 'invalid workspace id' }); return true; }
    try {
      const { bytes, baked, warnings } = await exportReport(workspaceId, format);
      const head = {
        'Content-Type': MIME[format],
        'Content-Length': bytes.byteLength,
        'X-Baked-Images': String(baked),
        'Cache-Control': 'no-store',
      };
      const encoded = encodeWarnings(warnings);
      if (encoded) head['X-Export-Warnings'] = encoded;
      res.writeHead(200, head);
      res.end(bytes); // already a Buffer: copying it again would double a 100 MB file
    } catch (err) {
      // An ExportError's message is written for the operator. Anything else
      // may carry a staged path or a stack, so it is logged and never sent.
      if (err instanceof ExportError) sendJson(res, err.status, { error: err.message, diagnostics: err.diagnostics ?? [] });
      else { console.error('[typst] export failed', err); sendJson(res, 500, { error: 'export failed' }); }
    }
    return true;
  }

  sendJson(res, 404, { error: 'not found' });
  return true;
}
