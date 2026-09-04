import type { ComponentType } from 'react';
import {
  Globe, Network, FileText, ArrowLeftRight, Braces, FileCode2, TextCursorInput, ExternalLink,
} from 'lucide-react';
import type { SiteNodeType } from '@/types';

/** Per-type icon + accent colour, shared by the graph node and the list panel. */
export const SITE_TYPE_META: Record<SiteNodeType, { label: string; icon: ComponentType<{ size?: number; className?: string }>; color: string }> = {
  root:      { label: 'Root',      icon: Globe,           color: 'hsl(var(--primary))' },
  subdomain: { label: 'Subdomain', icon: Network,         color: 'hsl(var(--status-blue))' },
  page:      { label: 'Page',      icon: FileText,        color: 'hsl(var(--foreground))' },
  endpoint:  { label: 'Endpoint',  icon: ArrowLeftRight,  color: 'hsl(var(--status-green))' },
  api:       { label: 'API',       icon: Braces,          color: 'hsl(var(--status-purple))' },
  js:        { label: 'JS',        icon: FileCode2,       color: 'hsl(var(--status-amber))' },
  form:      { label: 'Form',      icon: TextCursorInput, color: 'hsl(var(--status-blue))' },
  external:  { label: 'External',  icon: ExternalLink,    color: 'hsl(var(--muted-foreground))' },
};

/** Colour for an HTTP status code (2xx green, 3xx blue, 4xx amber, 5xx red). */
export function statusColor(status: number | null | undefined): string {
  if (status === null || status === undefined) return 'hsl(var(--muted-foreground))';
  if (status >= 200 && status < 300) return 'hsl(var(--status-green))';
  if (status >= 300 && status < 400) return 'hsl(var(--status-blue))';
  if (status >= 400 && status < 500) return 'hsl(var(--status-amber))';
  if (status >= 500) return 'hsl(var(--status-red))';
  return 'hsl(var(--muted-foreground))';
}

/** Best short label for a node: the URL path (or host for subdomains). */
export function shortLabel(url: string): string {
  if (!url) return '(unknown)';
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return path && path !== '/' ? path : u.host;
  } catch {
    return url;
  }
}
