/**
 * Auth client: thin wrappers around the server's REST endpoints plus a
 * persistent token store. Token + user info are kept in localStorage so a
 * page reload doesn't drop you back to the login screen.
 */
import { create } from 'zustand';

// Default to same-origin so the same build works on any host. Set
// VITE_API_URL / VITE_WS_URL only when the API lives on a different host.
function defaultApiUrl(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:1234';
  return window.location.origin;
}
function defaultWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:1234';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ||
  defaultApiUrl();

export const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined)?.replace(/\/$/, '') ||
  defaultWsUrl();

const TOKEN_KEY = 'alysa.auth.token';
const USER_KEY = 'alysa.auth.user';

export interface AuthUser {
  id: number;
  username: string;
  color: string;
}

function loadStoredToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function loadStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === 'number' && typeof parsed.username === 'string') {
      return parsed as AuthUser;
    }
  } catch { /* fallthrough */ }
  return null;
}

async function postJson<T>(path: string, body: unknown, token?: string | null): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) {
    throw new Error(data.error || `request failed (${res.status})`);
  }
  return data as T;
}

interface AuthResponse {
  token: string;
  user: AuthUser;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  status: 'unknown' | 'authenticated' | 'unauthenticated';
  error: string | null;
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: loadStoredUser(),
  token: loadStoredToken(),
  status: 'unknown',
  error: null,

  // Validate a stored token against the server. If it's bad (expired,
  // server restarted, etc.) wipe local state and show the login screen.
  bootstrap: async () => {
    const token = get().token;
    if (!token) {
      set({ status: 'unauthenticated' });
      return;
    }
    try {
      const res = await fetch(`${API_URL}/api/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { user: AuthUser };
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      set({ user: data.user, status: 'authenticated', error: null });
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      set({ user: null, token: null, status: 'unauthenticated' });
    }
  },

  login: async (username, password) => {
    set({ error: null });
    const data = await postJson<AuthResponse>('/api/login', { username, password });
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    set({ token: data.token, user: data.user, status: 'authenticated' });
  },

  register: async (username, password) => {
    set({ error: null });
    const data = await postJson<AuthResponse>('/api/register', { username, password });
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    set({ token: data.token, user: data.user, status: 'authenticated' });
  },

  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    set({ token: null, user: null, status: 'unauthenticated' });
  },
}));
