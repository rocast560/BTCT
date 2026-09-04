// Type surface of webrecon-scope.mjs for the TypeScript side (tests + tsc).
// Keep in sync with the .mjs; the runtime has no build step.

export interface NormalizedNode {
  key: string;
  type: string;
  url: string;
  method: string;
  status: number | null;
  contentType: string;
  title: string;
  size: number | null;
  params: string[];
  sources: string[];
  tags: string[];
  notes: string;
}

export interface NormalizedEdge {
  source: string;
  target: string;
  kind: string;
  label: string;
}

export interface NormalizedDoc {
  target: string;
  scannedAt: number;
  nodes: NormalizedNode[];
  edges: NormalizedEdge[];
}

export function computeKey(type: string, url: string, method: string): string;
export function normalizeSitemapDoc(obj: unknown): NormalizedDoc;
export function isBlockedIPv4(a: number, b: number, c: number, d: number): boolean;
export function isBlockedIPv6(host: string): boolean;
export function isBlockedHostLiteral(host: string): boolean;
export function assertScanTargetAllowed(target: string): URL;
