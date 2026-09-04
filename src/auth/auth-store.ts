/**
 * Auth client: thin wrappers around the server's REST endpoints plus a
 * persistent token store. Token + user info are kept in localStorage so a
 * page reload doesn't drop you back to the login screen.
 */
import { create } from 'zustand';
import { disposeSharedDoc } from '@/realtime/shared-doc';
import { disposeAllPageDocs } from '@/realtime/yjs-providers';
import type { EditorPrefs } from '@/lib/editor-prefs';
import type { CommandLogEntry } from '@/types';

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

export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ||
  defaultApiUrl();

export const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined)?.replace(/\/$/, '') ||
  defaultWsUrl();

const TOKEN_KEY = 'btct.auth.token';
const USER_KEY = 'btct.auth.user';

export interface RetentionStatus {
  days: number;
  lastRunAt: number | null;
  lastPruned: { ran: boolean; days: number; versions: number; assets: number; at: number } | null;
  dueVersionCount: number;
}

export interface AuthUser {
  id: number;
  username: string;
  color: string;
  isAdmin: boolean;
  // Per-account editor preferences (code-block accent + custom keybinds).
  // May be a partial blob from the server; merge with defaults via
  // `resolvePrefs` before use.
  prefs?: Partial<EditorPrefs> | null;
}

export interface AdminUserRow {
  id: number;
  username: string;
  color: string;
  isAdmin: boolean;
  createdAt: number;
}

/** Public (key-free) view of the Claude assistant configuration. */
export interface AiConfig {
  enabled: boolean;
  mode: 'view' | 'edit';
  model: string;
  configured: boolean;
}

export interface AiConfigInput {
  apiKey?: string;
  mode?: 'view' | 'edit';
  model?: string;
  enabled?: boolean;
}

/** MCP server config (admin). `token` is the bearer an MCP client uses. */
export interface McpConfig {
  enabled: boolean;
  mode: 'read' | 'edit';
  configured: boolean;
  token: string | null;
}
export interface McpConfigInput {
  enabled?: boolean;
  mode?: 'read' | 'edit';
}

/** Command-log ingest config (admin). `token` is the agent's bearer. */
export interface CmdlogConfig {
  enabled: boolean;
  configured: boolean;
  token: string | null;
  whitelist: string[];
  workspaceId: string | null;
}
/** Web recon config (admin). `token` is the external script's bearer. */
export interface WebreconConfig {
  ingestEnabled: boolean;
  scanEnabled: boolean;
  configured: boolean;
  token: string | null;
  workspaceId: string | null;
  platformSupported: boolean;
}
export interface WebreconConfigInput {
  ingestEnabled?: boolean;
  scanEnabled?: boolean;
  workspaceId?: string | null;
}
/** What the "Scan now" button reads to decide if it can run server-side. */
export interface WebreconScanStatus {
  scanEnabled: boolean;
  platformSupported: boolean;
  running: boolean;
}
export interface WebreconScanResult {
  siteMapId: string | null;
  nodes: number;
  edges: number;
}

/** Backup engine (server/backup.mjs): what a run covers. */
export interface BackupIncludes {
  sqlite: boolean;
  yjsShared: boolean;
  yjsPages: boolean;
  assets: boolean;
  history: boolean;
}

export interface BackupConfig {
  enabled: boolean;
  fullIntervalMin: number;
  includes: BackupIncludes;
  dir: string;
  token: string | null;
  configured: boolean;
  instanceId: string;
}

export interface BackupConfigInput {
  enabled?: boolean;
  fullIntervalMin?: number;
  includes?: Partial<BackupIncludes>;
}

export interface BackupLast {
  name: string;
  bytes: number;
  files: number;
  docs?: number;
  assets?: number;
  at: number;
  trigger: string;
  durationMs?: number;
}

export interface BackupStatus {
  enabled: boolean;
  fullIntervalMin: number;
  includes: BackupIncludes;
  dir: string;
  dirWritable: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  nextRunAt: number | null;
  lastBackup: BackupLast | null;
  usage: { count: number; totalBytes: number };
}

export interface BackupEntry {
  name: string;
  createdAt: string;
  bytes: number;
  files: number;
  includes: BackupIncludes | null;
  trigger: string | null;
  partial: boolean;
}

export interface BackupRunResult {
  ran: boolean;
  reason?: string;
  name?: string;
  bytes?: number;
  files?: number;
  durationMs?: number;
}

export interface CmdlogConfigInput {
  enabled?: boolean;
  whitelist?: string[];
  workspaceId?: string | null;
}

/** One durable Claude chat turn. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
/** Chat session metadata (list rows: no message bodies). */
export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
/** A full chat session including its messages. */
export interface ChatSessionFull extends ChatSessionMeta {
  messages: ChatMessage[];
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
      // Older builds may have a stale `avatar` field: strip it.
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
  updateProfile: (changes: { color?: string; prefs?: EditorPrefs }) => Promise<AuthUser>;
  // Claude assistant configuration (read: any user; write/test: admin only).
  aiGetConfig: () => Promise<AiConfig>;
  aiSaveConfig: (patch: AiConfigInput) => Promise<AiConfig>;
  aiTestConnection: () => Promise<{ ok: boolean; model: string }>;
  // Durable per-account Claude chat sessions.
  aiListSessions: () => Promise<ChatSessionMeta[]>;
  aiGetSession: (id: string) => Promise<ChatSessionFull>;
  aiSaveSession: (id: string, data: { title: string; messages: ChatMessage[]; createdAt?: number }) => Promise<ChatSessionMeta>;
  aiDeleteSession: (id: string) => Promise<void>;
  // MCP server config (admin only).
  mcpGetConfig: () => Promise<McpConfig>;
  mcpSaveConfig: (patch: McpConfigInput) => Promise<McpConfig>;
  mcpRegenerateToken: () => Promise<{ token: string }>;
  // Command-log ingest config (admin only) + archive query (any user).
  cmdlogGetConfig: () => Promise<CmdlogConfig>;
  cmdlogSaveConfig: (patch: CmdlogConfigInput) => Promise<CmdlogConfig>;
  cmdlogRegenerateToken: () => Promise<{ token: string }>;
  cmdlogQuery: (params: CmdlogQueryParams) => Promise<CommandLogEntry[]>;
  cmdlogAddManual: (entry: CmdlogManualInput) => Promise<CommandLogEntry>;
  webreconGetConfig: () => Promise<WebreconConfig>;
  webreconSaveConfig: (patch: WebreconConfigInput) => Promise<WebreconConfig>;
  webreconRegenerateToken: () => Promise<{ token: string }>;
  webreconScanStatus: () => Promise<WebreconScanStatus>;
  webreconRunScan: (input: { siteMapId?: string; target: string; workspaceId?: string }) => Promise<WebreconScanResult>;
  // Backups (admin only; status/run also accept the backup token server-side).
  backupGetConfig: () => Promise<BackupConfig>;
  backupSaveConfig: (patch: BackupConfigInput) => Promise<BackupConfig>;
  backupRegenerateToken: () => Promise<{ token: string }>;
  backupStatus: () => Promise<BackupStatus>;
  backupRun: () => Promise<BackupRunResult>;
  retentionGetConfig: () => Promise<RetentionStatus>;
  retentionSaveConfig: (patch: { days: number }) => Promise<RetentionStatus>;
  retentionRun: () => Promise<{ ran: boolean; days: number; versions: number; assets: number }>;
  retentionPruneHistoryRange: (after: number, before: number) => Promise<{ deleted: number }>;
  backupList: () => Promise<BackupEntry[]>;
  backupDelete: (name: string) => Promise<void>;
}

/** A hand-entered command-log record (manual add). */
export interface CmdlogManualInput {
  workspaceId: string;
  operator: string;
  command: string;
  tool?: string;
  host?: string;
  cwd?: string;
  startedAt?: number;
  exitCode?: number | null;
  durationMs?: number | null;
}

/** Filters for the durable command-log archive (all optional but workspaceId). */
export interface CmdlogQueryParams {
  workspaceId: string;
  operator?: string;
  tool?: string;
  host?: string;
  from?: number;
  to?: number;
  q?: string;
  status?: 'all' | 'success' | 'failed' | 'running';
  limit?: number;
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

  aiGetConfig: async () => {
    return getJson<AiConfig>('/api/ai/config', get().token);
  },
  aiSaveConfig: async (patch) => {
    return postJson<AiConfig>('/api/ai/config', patch, get().token);
  },
  aiTestConnection: async () => {
    return postJson<{ ok: boolean; model: string }>('/api/ai/config/test', {}, get().token);
  },

  aiListSessions: async () => {
    const data = await getJson<{ sessions: ChatSessionMeta[] }>('/api/ai/sessions', get().token);
    return data.sessions;
  },
  aiGetSession: async (id) => {
    const data = await getJson<{ session: ChatSessionFull }>(`/api/ai/sessions/${encodeURIComponent(id)}`, get().token);
    return data.session;
  },
  aiSaveSession: async (id, body) => {
    const data = await postJson<{ session: ChatSessionMeta }>(`/api/ai/sessions/${encodeURIComponent(id)}`, body, get().token);
    return data.session;
  },
  aiDeleteSession: async (id) => {
    await deleteJson(`/api/ai/sessions/${encodeURIComponent(id)}`, get().token);
  },

  mcpGetConfig: async () => {
    return getJson<McpConfig>('/api/mcp/config', get().token);
  },
  mcpSaveConfig: async (patch) => {
    return postJson<McpConfig>('/api/mcp/config', patch, get().token);
  },
  mcpRegenerateToken: async () => {
    return postJson<{ token: string }>('/api/mcp/token', {}, get().token);
  },

  cmdlogGetConfig: async () => {
    return getJson<CmdlogConfig>('/api/cmdlog/config', get().token);
  },
  cmdlogSaveConfig: async (patch) => {
    return postJson<CmdlogConfig>('/api/cmdlog/config', patch, get().token);
  },
  cmdlogRegenerateToken: async () => {
    return postJson<{ token: string }>('/api/cmdlog/token', {}, get().token);
  },
  cmdlogQuery: async (params) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '' && !(k === 'status' && v === 'all')) {
        qs.set(k, String(v));
      }
    }
    const data = await getJson<{ logs: CommandLogEntry[] }>(`/api/cmdlog/query?${qs.toString()}`, get().token);
    return data.logs;
  },
  webreconGetConfig: async () => getJson<WebreconConfig>('/api/webrecon/config', get().token),
  webreconSaveConfig: async (patch) => postJson<WebreconConfig>('/api/webrecon/config', patch, get().token),
  webreconRegenerateToken: async () => postJson<{ token: string }>('/api/webrecon/token', {}, get().token),
  webreconScanStatus: async () => getJson<WebreconScanStatus>('/api/webrecon/scan/status', get().token),
  webreconRunScan: async (input) => postJson<WebreconScanResult>('/api/webrecon/scan', input, get().token),
  cmdlogAddManual: async (entry) => {
    const data = await postJson<{ log: CommandLogEntry }>('/api/cmdlog/manual', entry, get().token);
    return data.log;
  },

  backupGetConfig: async () => getJson<BackupConfig>('/api/backup/config', get().token),
  backupSaveConfig: async (patch) => postJson<BackupConfig>('/api/backup/config', patch, get().token),
  backupRegenerateToken: async () => postJson<{ token: string }>('/api/backup/token', {}, get().token),
  backupStatus: async () => getJson<BackupStatus>('/api/backup/status', get().token),
  backupRun: async () => postJson<BackupRunResult>('/api/backup/run', {}, get().token),
  retentionGetConfig: async () => getJson<RetentionStatus>('/api/retention/config', get().token),
  retentionSaveConfig: async (patch) => postJson<RetentionStatus>('/api/retention/config', patch, get().token),
  retentionRun: async () => postJson<{ ran: boolean; days: number; versions: number; assets: number }>('/api/retention/run', {}, get().token),
  retentionPruneHistoryRange: async (after, before) => postJson<{ deleted: number }>('/api/retention/history-range', { after, before }, get().token),
  backupList: async () => (await getJson<{ backups: BackupEntry[] }>('/api/backup/list', get().token)).backups,
  backupDelete: async (name) => {
    await deleteJson<{ ok: boolean }>(`/api/backup/archives/${encodeURIComponent(name)}`, get().token);
  },
}));
