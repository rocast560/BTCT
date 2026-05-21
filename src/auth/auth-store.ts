/**
 * Auth client: thin wrappers around the server's REST endpoints plus a
 * persistent token store. Token + user info are kept in localStorage so a
 * page reload doesn't drop you back to the login screen.
 */
import { create } from 'zustand';
import { disposeSharedDoc } from '@/realtime/shared-doc';
import { disposeAllPageDocs } from '@/realtime/yjs-providers';

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

const TOKEN_KEY = 'btct.auth.token';
const USER_KEY = 'btct.auth.user';

export interface AuthUser {
  id: number;
  username: string;
  color: string;
  isAdmin: boolean;
}

export interface AdminUserRow {
  id: number;
  username: string;
  color: string;
  isAdmin: boolean;
  createdAt: number;
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
      // Older builds may have a stale `avatar` field — strip it.
      if ('avatar' in parsed) delete parsed.avatar;
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

async function getJson<T>(path: string, token?: string | null): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data as T;
}

async function deleteJson<T>(path: string, token?: string | null): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'DELETE',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
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
  logout: () => void;
  // Admin-only operations (will fail with 403 for non-admin tokens).
  adminListUsers: () => Promise<AdminUserRow[]>;
  adminCreateUser: (username: string, password: string, isAdmin: boolean) => Promise<AdminUserRow>;
  adminDeleteUser: (id: number) => Promise<void>;
  adminResetPassword: (id: number, password: string) => Promise<void>;
  // Self-service profile editing for any authenticated user.
  updateProfile: (changes: { color?: string }) => Promise<AuthUser>;
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
    // Defensive cleanup: if a previous session's Yjs providers were left
    // around (token-expiry path, or a stale singleton from before this
    // tab's reload), tear them down so the new session rebuilds them
    // with the current token instead of reconnecting under the old one.
    disposeAllPageDocs();
    disposeSharedDoc();
    const data = await postJson<AuthResponse>('/api/login', { username, password });
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    set({ token: data.token, user: data.user, status: 'authenticated' });
  },

  logout: () => {
    // Tear down every Yjs provider before clearing the token so the next
    // session always builds fresh providers tied to the current auth
    // token. Without this the WebsocketProvider keeps the old token in
    // its query string and the new session's edits never propagate.
    disposeAllPageDocs();
    disposeSharedDoc();
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    set({ token: null, user: null, status: 'unauthenticated' });
  },

  adminListUsers: async () => {
    const token = get().token;
    const data = await getJson<{ users: AdminUserRow[] }>('/api/admin/users', token);
    return data.users;
  },

  adminCreateUser: async (username, password, isAdmin) => {
    const token = get().token;
    const data = await postJson<{ user: AdminUserRow }>(
      '/api/admin/users',
      { username, password, isAdmin },
      token,
    );
    return data.user;
  },

  adminDeleteUser: async (id) => {
    const token = get().token;
    await deleteJson<{ ok: true }>(`/api/admin/users/${id}`, token);
  },

  adminResetPassword: async (id, password) => {
    const token = get().token;
    await postJson<{ ok: true }>(`/api/admin/users/${id}/password`, { password }, token);
  },

  updateProfile: async (changes) => {
    const token = get().token;
    const data = await postJson<{ user: AuthUser }>('/api/me/profile', changes, token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    set({ user: data.user });
    return data.user;
  },
}));
