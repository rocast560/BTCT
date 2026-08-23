/**
 * Global theme store. The accent colour and the admin heading-colour policy
 * (default heading colours for everyone, plus the hard-lock) live in the
 * server's SQLite settings table so every LAN client sees the same theme.
 * The store seeds from `GET /api/settings` on app start, then follows the
 * server-written `settingsPublic.theme` mirror in the shared doc (wired in
 * shared-bindings.ts) so an admin change re-themes every connected client
 * without a reload. `updatedAt` is the server's stamp for the last change:
 * a payload older than what we already hold (a stale mirror copy replayed
 * from IndexedDB) is ignored.
 *
 * Side-effect: every accepted payload paints the accent onto :root via
 * applyThemeColor. Heading colours are painted by App.tsx, which combines
 * this policy with the user's own prefs through resolveEffectiveHeadings.
 */
import { create } from 'zustand';
import { useAuthStore } from '@/auth/auth-store';
import { applyThemeColor, DEFAULT_THEME_COLOR } from '@/lib/theme';
import { resolveThemePrefs, type ThemePrefs } from '@/lib/editor-prefs';

function apiUrl(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:1234';
  const fromEnv = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '');
  return fromEnv || window.location.origin;
}

/** Shape of GET /api/settings and of the `settingsPublic.theme` mirror. */
export interface PublicThemeSettings {
  themeColor?: string;
  themeHeadings?: unknown;
  themeLock?: boolean;
  themeUpdatedAt?: number;
}

/** Admin-only patch for POST /api/settings/theme; every field is optional. */
export interface ThemeUpdate {
  color?: string;
  headings?: ThemePrefs;
  lock?: boolean;
}

interface ThemeState {
  color: string;
  /** Admin heading colours: the default for everyone, forced when `lock` is on. */
  headings: ThemePrefs;
  lock: boolean;
  /** Server stamp of the last theme change; older payloads are ignored. */
  updatedAt: number;
  loaded: boolean;
  loadTheme: () => Promise<void>;
  /** Accept a server payload (REST seed or live mirror); stale ones are dropped. */
  applyServerTheme: (data: PublicThemeSettings | null | undefined) => void;
  // Admin-only: fails with 403 otherwise. Optimistically paints a new
  // accent so the picker feels instant; reverts on server error.
  updateTheme: (patch: ThemeUpdate) => Promise<void>;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const useThemeStore = create<ThemeState>((set, get) => ({
  color: DEFAULT_THEME_COLOR,
  headings: { headingColor: null, headings: {} },
  lock: false,
  updatedAt: 0,
  loaded: false,

  applyServerTheme: (data) => {
    if (!data || typeof data !== 'object') return;
    const raw = Number(data.themeUpdatedAt ?? 0);
    const stamp = Number.isFinite(raw) ? raw : 0;
    if (stamp < get().updatedAt) return; // stale copy of the mirror
    const color =
      typeof data.themeColor === 'string' && HEX_RE.test(data.themeColor)
        ? data.themeColor
        : get().color;
    applyThemeColor(color);
    set({
      color,
      headings: resolveThemePrefs(data.themeHeadings),
      lock: data.themeLock === true,
      updatedAt: stamp,
      loaded: true,
    });
  },

  loadTheme: async () => {
    try {
      const res = await fetch(`${apiUrl()}/api/settings`);
      if (!res.ok) throw new Error(String(res.status));
      get().applyServerTheme((await res.json()) as PublicThemeSettings);
    } catch {
      // Network/server hiccup: fall back to the default so the UI never
      // ends up uncolored, but leave `loaded` false so a later retry can
      // overwrite it.
      applyThemeColor(DEFAULT_THEME_COLOR);
      set({ color: DEFAULT_THEME_COLOR });
    }
  },

  updateTheme: async (patch) => {
    const prev = get().color;
    if (patch.color) {
      applyThemeColor(patch.color);
      set({ color: patch.color });
    }
    try {
      const token = useAuthStore.getState().token;
      const res = await fetch(`${apiUrl()}/api/settings/theme`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(patch),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string } & PublicThemeSettings;
      if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
      get().applyServerTheme(data);
    } catch (err) {
      applyThemeColor(prev);
      set({ color: prev });
      throw err;
    }
  },
}));
