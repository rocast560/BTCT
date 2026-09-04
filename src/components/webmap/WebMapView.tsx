import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore, type WebreconScanStatus } from '@/auth/auth-store';
import { Upload, Radar, Globe, Loader2 } from 'lucide-react';
import { SiteMapCanvas } from './SiteMapCanvas';
import { EndpointList } from './EndpointList';

export function WebMapView({ siteMapId }: { siteMapId: string }) {
  const { siteMaps, importSiteMapText, setSiteMapRoot, runServerScan } = useAppStore(useShallow((s) => ({
    siteMaps: s.siteMaps,
    importSiteMapText: s.importSiteMapText,
    setSiteMapRoot: s.setSiteMapRoot,
    runServerScan: s.runServerScan,
  })));
  const webreconScanStatus = useAuthStore((s) => s.webreconScanStatus);

  const map = siteMaps.find((m) => m.id === siteMapId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [rootDraft, setRootDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scanInfo, setScanInfo] = useState<WebreconScanStatus | null>(null);

  useEffect(() => { setRootDraft(map?.rootUrl ?? ''); }, [map?.rootUrl]);
  useEffect(() => {
    void webreconScanStatus().then(setScanInfo).catch(() => setScanInfo(null));
  }, [webreconScanStatus]);

  const flash = (m: string, isErr = false) => {
    if (isErr) { setErr(m); setMsg(null); } else { setMsg(m); setErr(null); }
    setTimeout(() => { setMsg(null); setErr(null); }, 4000);
  };

  const handleImport = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      let nodes = 0, edges = 0;
      for (let i = 0; i < files.length; i++) {
        const text = await files[i]!.text();
        const r = await importSiteMapText(siteMapId, text);
        nodes += r.nodes; edges += r.edges;
      }
      flash(`Imported ${nodes} nodes, ${edges} edges`);
    } catch (e) {
      flash(e instanceof Error ? e.message : 'import failed', true);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [importSiteMapText, siteMapId]);

  const saveRoot = useCallback(() => {
    const v = rootDraft.trim();
    if (v !== (map?.rootUrl ?? '')) void setSiteMapRoot(siteMapId, v);
  }, [rootDraft, map?.rootUrl, setSiteMapRoot, siteMapId]);

  const handleScan = useCallback(async () => {
    setBusy(true);
    try {
      const r = await runServerScan(siteMapId);
      flash(`Scan complete: ${r.nodes} nodes, ${r.edges} edges`);
    } catch (e) {
      flash(e instanceof Error ? e.message : 'scan failed', true);
    } finally {
      setBusy(false);
    }
  }, [runServerScan, siteMapId]);

  if (!map) {
    return <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">Web map not found.</div>;
  }

  const scanAvailable = !!scanInfo?.scanEnabled && !!scanInfo?.platformSupported;
  const scanTitle = !scanInfo?.platformSupported
    ? 'Server-side scanning needs a Linux host'
    : !scanInfo?.scanEnabled
      ? 'An admin must enable server-side scanning'
      : !map.rootUrl
        ? 'Set a target URL first'
        : 'Scan the target from the server';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header + toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(var(--border))] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Globe size={15} className="text-[hsl(var(--primary))]" />
          <h1 className="text-sm font-bold">{map.name}</h1>
        </div>
        <div className="flex min-w-[220px] flex-1 items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">Target</span>
          <input
            value={rootDraft}
            onChange={(e) => setRootDraft(e.target.value)}
            onBlur={saveRoot}
            onKeyDown={(e) => { if (e.key === 'Enter') { saveRoot(); (e.target as HTMLInputElement).blur(); } }}
            placeholder="https://example.com"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-1 font-mono text-[11px] outline-none focus:border-[hsl(var(--primary))]"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <input ref={fileRef} type="file" accept=".json,application/json" multiple className="hidden" onChange={(e) => void handleImport(e.target.files)} />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider hover:bg-[hsl(var(--accent))] disabled:opacity-40"
          >
            <Upload size={12} /> Import
          </button>
          <button
            onClick={() => void handleScan()}
            disabled={busy || !scanAvailable || !map.rootUrl}
            title={scanTitle}
            className="flex items-center gap-1.5 rounded-full border border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/20 disabled:opacity-40"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Radar size={12} />} Scan now
          </button>
        </div>
        {(msg || err) && (
          <div className={`w-full text-[11px] ${err ? 'text-[hsl(var(--status-red))]' : 'text-[hsl(var(--muted-foreground))]'}`}>{err || msg}</div>
        )}
      </div>

      {/* Graph + list */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 border-r border-[hsl(var(--border))]">
          <SiteMapCanvas siteMapId={siteMapId} />
        </div>
        <div className="hidden w-[360px] shrink-0 sm:block">
          <EndpointList siteMapId={siteMapId} />
        </div>
      </div>
    </div>
  );
}
