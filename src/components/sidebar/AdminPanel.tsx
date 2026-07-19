import { useEffect, useState } from 'react';
import { Shield, X, Trash2, Plus, KeyRound, Sparkles, Plug, Copy, RefreshCw } from 'lucide-react';
import { useAuthStore, type AdminUserRow, type AiConfig, type McpConfig } from '@/auth/auth-store';

/**
 * Admin-only modal panel for managing user accounts. Lists every user, lets
 * an admin create new accounts, reset passwords, and delete users (except
 * themselves and the last remaining admin — those are blocked server-side).
 */
export function AdminPanel({ onClose }: { onClose: () => void }) {
  const me = useAuthStore((s) => s.user);
  const adminListUsers = useAuthStore((s) => s.adminListUsers);
  const adminCreateUser = useAuthStore((s) => s.adminCreateUser);
  const adminDeleteUser = useAuthStore((s) => s.adminDeleteUser);
  const adminResetPassword = useAuthStore((s) => s.adminResetPassword);

  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-user form
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);

  // Reset-password inline state per user id
  const [resettingId, setResettingId] = useState<number | null>(null);
  const [resetPwd, setResetPwd] = useState('');

  const refresh = async () => {
    try {
      const list = await adminListUsers();
      setUsers(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load users');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!newUsername.trim()) return setError('username is required');
    if (newPassword.length < 8) return setError('password must be at least 8 characters');
    setBusy(true);
    try {
      await adminCreateUser(newUsername.trim(), newPassword, newIsAdmin);
      setNewUsername('');
      setNewPassword('');
      setNewIsAdmin(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create failed');
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async (id: number) => {
    setError(null);
    if (resetPwd.length < 8) return setError('password must be at least 8 characters');
    setBusy(true);
    try {
      await adminResetPassword(id, resetPwd);
      setResettingId(null);
      setResetPwd('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reset failed');
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async (id: number, username: string) => {
    if (!window.confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    setError(null);
    setBusy(true);
    try {
      await adminDeleteUser(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-white/10 bg-[hsl(var(--card))] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-[hsl(var(--status-amber))]" />
            <h2 className="text-sm font-semibold">Admin Panel — Users</h2>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-white/10" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {error && (
            <div className="mb-3 rounded-lg border border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-3 py-2 text-xs text-[hsl(var(--status-red))]">
              {error}
            </div>
          )}

          {/* Claude AI Assistant configuration */}
          <AiConfigSection />

          {/* MCP server configuration */}
          <McpConfigSection />

          {/* Create-user form */}
          <form
            onSubmit={submitCreate}
            className="mb-4 rounded-xl border border-white/10 bg-black/20 p-3"
          >
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-white/70">
              <Plus size={12} /> Create user
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                type="text"
                placeholder="Username"
                autoComplete="off"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                className="rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-sm outline-none focus:border-white/30"
              />
              <input
                type="password"
                placeholder="Password (min 8)"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-sm outline-none focus:border-white/30"
              />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-white/70">
                <input
                  type="checkbox"
                  checked={newIsAdmin}
                  onChange={(e) => setNewIsAdmin(e.target.checked)}
                />
                Grant admin privileges
              </label>
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-white/90 px-3 py-1.5 text-xs font-medium text-black hover:bg-white disabled:opacity-50"
              >
                {busy ? 'Working…' : 'Create'}
              </button>
            </div>
          </form>

          {/* User list */}
          <div className="overflow-hidden rounded-xl border border-white/10">
            <table className="w-full text-left text-xs">
              <thead className="bg-white/5 text-white/60">
                <tr>
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = me?.id === u.id;
                  return (
                    <tr key={u.id} className="border-t border-white/5">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: u.color }}
                            aria-hidden="true"
                          />
                          <span className="font-medium">{u.username}</span>
                          {isSelf && (
                            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase text-white/60">
                              you
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {u.isAdmin ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--status-amber))]/20 px-2 py-0.5 text-[10px] uppercase text-[hsl(var(--status-amber))]">
                            <Shield size={10} /> admin
                          </span>
                        ) : (
                          <span className="text-white/50">user</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-white/50">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-3 py-2">
                        {resettingId === u.id ? (
                          <div className="flex items-center justify-end gap-1">
                            <input
                              type="password"
                              autoFocus
                              placeholder="New password"
                              value={resetPwd}
                              onChange={(e) => setResetPwd(e.target.value)}
                              className="w-32 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs outline-none focus:border-white/30"
                            />
                            <button
                              onClick={() => void submitReset(u.id)}
                              disabled={busy}
                              className="rounded-md bg-white/90 px-2 py-1 text-[11px] font-medium text-black hover:bg-white disabled:opacity-50"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => { setResettingId(null); setResetPwd(''); }}
                              className="rounded-md px-2 py-1 text-[11px] text-white/60 hover:bg-white/10"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => { setResettingId(u.id); setResetPwd(''); }}
                              className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
                              title="Reset password"
                            >
                              <KeyRound size={13} />
                            </button>
                            <button
                              onClick={() => void submitDelete(u.id, u.username)}
                              disabled={isSelf}
                              className="rounded-md p-1 text-[hsl(var(--status-red))] hover:bg-[hsl(var(--status-red))]/10 disabled:opacity-30"
                              title={isSelf ? 'Cannot delete your own account' : 'Delete user'}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-center text-white/50">
                      No users
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Where the admin pastes the Anthropic API key and picks the assistant mode.
 * The key is write-only — the server never returns it, so the field renders
 * empty and we only surface a "Connected ✓ / Not configured" status.
 */
function AiConfigSection() {
  const aiGetConfig = useAuthStore((s) => s.aiGetConfig);
  const aiSaveConfig = useAuthStore((s) => s.aiSaveConfig);
  const aiTestConnection = useAuthStore((s) => s.aiTestConnection);

  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-opus-4-8');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void aiGetConfig().then((c) => { setCfg(c); setModel(c.model); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: Parameters<typeof aiSaveConfig>[0], note: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const c = await aiSaveConfig(patch);
      setCfg(c); setModel(c.model);
      setMsg(note);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save failed');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await aiTestConnection();
      setMsg(`Connection OK (${r.model})`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'test failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-white/70">
        <Sparkles size={12} className="text-[hsl(var(--primary))]" /> Claude AI Assistant
      </div>

      {/* API key */}
      <label className="mb-1 block text-[10px] uppercase tracking-wider text-white/50">Anthropic API key</label>
      <div className="flex items-center gap-2">
        <input
          type="password"
          placeholder={cfg?.configured ? '•••••••••• (saved)' : 'sk-ant-…'}
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-xs outline-none focus:border-white/30"
        />
        <button
          onClick={() => { void save({ apiKey }, 'API key saved'); setApiKey(''); }}
          disabled={busy || !apiKey.trim()}
          className="rounded-md bg-white/90 px-3 py-1.5 text-xs font-medium text-black hover:bg-white disabled:opacity-40"
        >
          Save key
        </button>
      </div>
      <div className="mt-1 text-[11px]">
        {cfg?.configured
          ? <span className="text-[hsl(var(--status-green,142_71%_45%))]" style={{ color: '#4ade80' }}>Connected ✓</span>
          : <span className="text-white/50">Not configured</span>}
      </div>

      {/* Mode + enable */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-white/60">Mode</span>
        <div className="flex overflow-hidden rounded-md border border-white/10">
          {(['view', 'edit'] as const).map((m) => (
            <button
              key={m}
              onClick={() => void save({ mode: m }, `Mode set to ${m}`)}
              disabled={busy}
              className={`px-2.5 py-1 text-[11px] ${cfg?.mode === m ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'text-white/60 hover:bg-white/10'}`}
            >
              {m === 'view' ? 'View only' : 'Edit'}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-[11px] text-white/70">
          <input
            type="checkbox"
            checked={!!cfg?.enabled}
            onChange={(e) => void save({ enabled: e.target.checked }, e.target.checked ? 'Assistant enabled' : 'Assistant disabled')}
          />
          Enabled
        </label>
      </div>

      {/* Model + test */}
      <div className="mt-3 flex items-center gap-2">
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-xs outline-none focus:border-white/30"
        />
        <button
          onClick={() => void save({ model }, 'Model saved')}
          disabled={busy}
          className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] hover:bg-white/10 disabled:opacity-40"
        >
          Save model
        </button>
        <button
          onClick={() => void test()}
          disabled={busy || !cfg?.configured}
          className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] hover:bg-white/10 disabled:opacity-40"
        >
          Test
        </button>
      </div>

      {(msg || err) && (
        <div className={`mt-2 text-[11px] ${err ? 'text-[hsl(var(--status-red))]' : 'text-white/60'}`}>
          {err || msg}
        </div>
      )}
    </div>
  );
}

/**
 * Admin config for the hosted MCP server: enable it, toggle read-only vs edit
 * permissions, and reveal/copy/regenerate the bearer token an MCP client (e.g.
 * Claude Code CLI) uses to connect.
 */
function McpConfigSection() {
  const mcpGetConfig = useAuthStore((s) => s.mcpGetConfig);
  const mcpSaveConfig = useAuthStore((s) => s.mcpSaveConfig);
  const mcpRegenerateToken = useAuthStore((s) => s.mcpRegenerateToken);

  const [cfg, setCfg] = useState<McpConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    void mcpGetConfig().then(setCfg).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const token = cfg?.token || '';
  const connectCmd = `claude mcp add --transport http btct ${origin}/mcp --header "Authorization: Bearer ${token || '<token>'}"`;

  const save = async (patch: Parameters<typeof mcpSaveConfig>[0], note: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { setCfg(await mcpSaveConfig(patch)); setMsg(note); }
    catch (e) { setErr(e instanceof Error ? e.message : 'save failed'); }
    finally { setBusy(false); }
  };
  const regen = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const { token: t } = await mcpRegenerateToken();
      setCfg((c) => (c ? { ...c, token: t, configured: true } : c));
      setRevealed(true); setMsg('Token regenerated');
    } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); }
    finally { setBusy(false); }
  };
  const copy = (text: string) => {
    try { void navigator.clipboard.writeText(text); setMsg('Copied'); } catch { /* ignore */ }
  };

  return (
    <div className="mb-4 rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-white/70">
        <Plug size={12} className="text-[hsl(var(--primary))]" /> MCP Server
      </div>
      <p className="mb-2 text-[10px] text-white/50">
        Let an external MCP client (e.g. Claude Code CLI) read all workspace context. Turn on Edit permissions to also let it make changes.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[11px] text-white/70">
          <input
            type="checkbox"
            checked={!!cfg?.enabled}
            onChange={(e) => void save({ enabled: e.target.checked }, e.target.checked ? 'MCP enabled' : 'MCP disabled')}
          />
          Enabled
        </label>
        <span className="ml-2 text-[11px] text-white/60">Edit permissions</span>
        <div className="flex overflow-hidden rounded-md border border-white/10">
          {(['read', 'edit'] as const).map((m) => (
            <button
              key={m}
              onClick={() => void save({ mode: m }, `MCP mode: ${m}`)}
              disabled={busy}
              className={`px-2.5 py-1 text-[11px] ${cfg?.mode === m ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'text-white/60 hover:bg-white/10'}`}
            >
              {m === 'read' ? 'Read-only' : 'Edit'}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1 text-[11px]">
        {cfg?.configured
          ? <span style={{ color: '#4ade80' }}>Connected ✓</span>
          : <span className="text-white/50">Not configured — enable to generate a token</span>}
      </div>

      {cfg?.configured && (
        <div className="mt-3 space-y-2">
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-white/50">Access token (treat like a password)</label>
            <div className="flex items-center gap-1.5">
              <input
                readOnly
                type={revealed ? 'text' : 'password'}
                value={token}
                className="flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-xs outline-none"
              />
              <button onClick={() => setRevealed((r) => !r)} className="rounded-md border border-white/10 px-2 py-1.5 text-[10px] hover:bg-white/10">{revealed ? 'Hide' : 'Reveal'}</button>
              <button onClick={() => copy(token)} title="Copy token" className="rounded-md border border-white/10 p-1.5 hover:bg-white/10"><Copy size={11} /></button>
              <button onClick={() => void regen()} disabled={busy} title="Regenerate" className="rounded-md border border-white/10 p-1.5 hover:bg-white/10"><RefreshCw size={11} /></button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-white/50">Connect (Claude Code CLI)</label>
            <div className="flex items-start gap-1.5">
              <code className="flex-1 overflow-x-auto whitespace-pre rounded-md border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[10px] text-white/80">{connectCmd}</code>
              <button onClick={() => copy(connectCmd)} title="Copy command" className="rounded-md border border-white/10 p-1.5 hover:bg-white/10"><Copy size={11} /></button>
            </div>
          </div>
        </div>
      )}

      {(msg || err) && (
        <div className={`mt-2 text-[11px] ${err ? 'text-[hsl(var(--status-red))]' : 'text-white/60'}`}>{err || msg}</div>
      )}
    </div>
  );
}
