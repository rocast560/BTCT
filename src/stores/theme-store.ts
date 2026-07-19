/**
 * Global theme color store. The color lives in the server's SQLite
 * settings table so every LAN client sees the same theme; this store
 * fetches it on app start and writes updates back through the admin-only
 * REST endpoint. Side-effect: every successful read/write also paints
 * the new color onto :root via applyThemeColor.
 */
import { create } from 'zustand';
import { useAuthStore } from '@/auth/auth-store';
import { applyThemeColor, DEFAULT_THEME_COLOR } from '@/lib/theme';

function apiUrl(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:1234';
  const fromEnv = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '');
  return fromEnv || window.location.origin;
}

interface ThemeState {
  color: string;
  loaded: boolean;
  loadTheme: () => Promise<void>;
  // Admin-only — fails with 403 otherwise. Optimistically paints the new
  // color so the picker feels instant; reverts on server error.
  updateTheme: (color: string) => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  color: DEFAULT_THEME_COLOR,
  loaded: false,

  loadTheme: async () => {
    try {
      const res = await fetch(`${apiUrl()}/api/settings`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { themeColor?: string };
      const color = data.themeColor || DEFAULT_THEME_COLOR;
      applyThemeColor(color);
      set({ color, loaded: true });
    } catch {
      // Network/server hiccup: fall back to the default so the UI never
      // ends up uncolored, but leave `loaded` false so a later retry can
      // overwrite it.
      applyThemeColor(DEFAULT_THEME_COLOR);
      set({ color: DEFAULT_THEME_COLOR });
    }
  },

  updateTheme: async (color: string) => {
    const prev = get().color;
    applyThemeColor(color);
    set({ color });
    try {
      const token = useAuthStore.getState().token;
      const res = await fetch(`${apiUrl()}/api/settings/theme`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ color }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; themeColor?: string };
      if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
      const next = data.themeColor || color;
      applyThemeColor(next);
      set({ color: next, loaded: true });
    } catch (err) {
      applyThemeColor(prev);
      set({ color: prev });
      throw err;
    }
  },
}));
