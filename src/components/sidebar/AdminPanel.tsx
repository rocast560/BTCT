import { useEffect, useState } from 'react';
import { Shield, X, Trash2, Plus, KeyRound, Sparkles, Plug, Copy, RefreshCw, Terminal, HardDrive, Play, EyeOff } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  useAuthStore,
  type AdminUserRow,
  type AiConfig,
  type McpConfig,
  type CmdlogConfig,
  type BackupConfig,
  type BackupConfigInput,
  type BackupStatus,
  type BackupEntry,
} from '@/auth/auth-store';
import { useAppStore } from '@/stores';
import { useThemeStore } from '@/stores/theme-store';

/**
 * Admin-only modal panel for managing user accounts. Lists every user, lets
 * an admin create new accounts, reset passwords, and delete users (except
 * themselves and the last remaining admin: those are blocked server-side).
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
  const [pendingDelete, setPendingDelete] = useState<{ id: number; username: string } | null>(null);

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

  const submitDelete = async (id: number) => {
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
    <>
    {pendingDelete && (
      <ConfirmDialog
        title="Delete user"
        message={`Delete user "${pendingDelete.username}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => { const p = pendingDelete; setPendingDelete(null); void submitDelete(p.id); }}
      />
    )}
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
            <h2 className="text-sm font-semibold">Admin Panel: Users</h2>
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

          {/* Command-log ingest configuration */}
          <CmdlogConfigSection />

          {/* Scheduled backups to the host folder */}
          <BackupConfigSection />

          {/* Default strength for new blur regions on report screenshots */}
          <BlurConfigSection />

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
                              onClick={() => setPendingDelete({ id: u.id, username: u.username })}
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
    </>
  );
}

/**
 * Where the admin pastes the Anthropic API key and picks the assistant mode.
 * The key is write-only: the server never returns it, so the field renders
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
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="text-[11px] text-white/60">Mode</span>
        <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-white/10 p-0.5">
          {(['view', 'edit'] as const).map((m) => (
            <button
              key={m}
              onClick={() => void save({ mode: m }, `Mode set to ${m}`)}
              disabled={busy}
              className={`min-w-[76px] whitespace-nowrap rounded-md px-3 py-1 text-[11px] font-medium ${cfg?.mode === m ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'text-white/60 hover:bg-white/10'}`}
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
        <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-white/10 p-0.5">
          {(['read', 'edit'] as const).map((m) => (
            <button
              key={m}
              onClick={() => void save({ mode: m }, `MCP mode: ${m}`)}
              disabled={busy}
              className={`min-w-[76px] whitespace-nowrap rounded-md px-3 py-1 text-[11px] font-medium ${cfg?.mode === m ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'text-white/60 hover:bg-white/10'}`}
            >
              {m === 'read' ? 'Read-only' : 'Edit'}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1 text-[11px]">
        {cfg?.configured
          ? <span style={{ color: '#4ade80' }}>Connected ✓</span>
          : <span className="text-white/50">Not configured: enable to generate a token</span>}
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

/**
 * Admin config for the team command log: enable ingest (mints the shared
 * bearer token operators launch the capture agent with), edit the whitelist of
 * tools that get logged, pick the default target workspace, and copy a
 * ready-to-run agent install command.
 */
function CmdlogConfigSection() {
  const cmdlogGetConfig = useAuthStore((s) => s.cmdlogGetConfig);
  const cmdlogSaveConfig = useAuthStore((s) => s.cmdlogSaveConfig);
  const cmdlogRegenerateToken = useAuthStore((s) => s.cmdlogRegenerateToken);
  const workspaces = useAppStore((s) => s.workspaces);

  const [cfg, setCfg] = useState<CmdlogConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [wlText, setWlText] = useState('');

  useEffect(() => {
    void cmdlogGetConfig().then((c) => { setCfg(c); setWlText(c.whitelist.join('\n')); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const token = cfg?.token || '';
  const installCmd = `python3 -m btct_agent install --server ${origin} --token ${token || '<token>'} --operator <you>`;

  const save = async (patch: Parameters<typeof cmdlogSaveConfig>[0], note: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { const c = await cmdlogSaveConfig(patch); setCfg(c); setWlText(c.whitelist.join('\n')); setMsg(note); }
    catch (e) { setErr(e instanceof Error ? e.message : 'save failed'); }
    finally { setBusy(false); }
  };
  const saveWhitelist = () => {
    const tools = wlText.split(/[\n,]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    void save({ whitelist: tools }, `Whitelist saved (${tools.length} tools)`);
  };
  const regen = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const { token: t } = await cmdlogRegenerateToken();
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
        <Terminal size={12} className="text-[hsl(var(--status-green))]" /> Command Log
      </div>
      <p className="mb-2 text-[10px] text-white/50">
        Let operators' Kali boxes ship whitelisted shell commands into the Command Log tab. Each operator runs the capture agent with the token below.
      </p>

      <label className="flex items-center gap-2 text-[11px] text-white/70">
        <input
          type="checkbox"
          checked={!!cfg?.enabled}
          onChange={(e) => void save({ enabled: e.target.checked }, e.target.checked ? 'Ingest enabled' : 'Ingest disabled')}
        />
        Enabled
      </label>
      <div className="mt-1 text-[11px]">
        {cfg?.configured
          ? <span style={{ color: '#4ade80' }}>Ready ✓</span>
          : <span className="text-white/50">Not configured: enable to generate a token</span>}
      </div>

      {cfg?.configured && (
        <div className="mt-3 space-y-3">
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-white/50">Ingest token (treat like a password)</label>
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
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-white/50">Default workspace (where commands land)</label>
            <select
              value={cfg.workspaceId ?? ''}
              onChange={(e) => void save({ workspaceId: e.target.value || null }, 'Default workspace set')}
              className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-xs outline-none"
            >
              <option value="">none (uses first workspace)</option>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-white/50">Whitelist (one tool per line)</label>
            <textarea
              value={wlText}
              onChange={(e) => setWlText(e.target.value)}
              rows={5}
              spellCheck={false}
              className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[11px] outline-none"
            />
            <button onClick={saveWhitelist} disabled={busy} className="mt-1 rounded-md border border-white/10 px-2.5 py-1 text-[11px] hover:bg-white/10">Save whitelist</button>
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-white/50">Install on a Kali box</label>
            <div className="flex items-start gap-1.5">
              <code className="flex-1 overflow-x-auto whitespace-pre rounded-md border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[10px] text-white/80">{installCmd}</code>
              <button onClick={() => copy(installCmd)} title="Copy command" className="rounded-md border border-white/10 p-1.5 hover:bg-white/10"><Copy size={11} /></button>
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

// ── Backups ─────────────────────────────────────────────────────────────
//
// Consistent snapshots of the whole instance into the host folder mounted
// at BACKUP_DIR (server/backup.mjs). Toggles save immediately (the MCP
// section's pattern); the interval commits on blur/Enter. Nothing is deleted
// automatically, so the inventory below is the retention tool.

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = n / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)} ${units[i]}`;
}

function fmtWhen(ms: number | null | undefined): string {
  if (!ms) return 'never';
  return new Date(ms).toLocaleString();
}

function fmtUntil(ms: number | null | undefined): string {
  if (!ms) return 'not scheduled';
  const mins = Math.round((ms - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  return `in ${h} h ${mins - h * 60} min`;
}

const INCLUDE_LABELS: ReadonlyArray<{ key: keyof BackupConfig['includes']; label: string; hint: string }> = [
  { key: 'sqlite', label: 'Accounts & settings', hint: 'SQLite: users, prefs, settings, chat sessions, asset index' },
  { key: 'yjsShared', label: 'Workspace metadata', hint: 'the shared doc: pages list, graphs, findings, chains, nmap, change log' },
  { key: 'yjsPages', label: 'Page bodies', hint: 'one Yjs document per page' },
  { key: 'assets', label: 'Uploaded assets', hint: 'Typst screenshots and fonts' },
  { key: 'history', label: 'Version history', hint: 'per-page history twins behind version diffs' },
];

function BackupConfigSection() {
  const backupGetConfig = useAuthStore((s) => s.backupGetConfig);
  const backupSaveConfig = useAuthStore((s) => s.backupSaveConfig);
  const backupRegenerateToken = useAuthStore((s) => s.backupRegenerateToken);
  const backupStatus = useAuthStore((s) => s.backupStatus);
  const backupRun = useAuthStore((s) => s.backupRun);
  const backupList = useAuthStore((s) => s.backupList);
  const backupDelete = useAuthStore((s) => s.backupDelete);

  const [cfg, setCfg] = useState<BackupConfig | null>(null);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [list, setList] = useState<BackupEntry[]>([]);
  const [intervalMin, setIntervalMin] = useState('60');
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  const refresh = async () => {
    try {
      const [c, s, l] = await Promise.all([backupGetConfig(), backupStatus(), backupList()]);
      setCfg(c);
      setStatus(s);
      setList(l);
      setIntervalMin(String(c.fullIntervalMin));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load backup settings');
    }
  };
  useEffect(() => {
    void refresh();
    // Status is cheap; poll it while the panel is open so a scheduled run shows up.
    const t = window.setInterval(() => { void backupStatus().then(setStatus).catch(() => {}); }, 15000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: BackupConfigInput, note: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      setCfg(await backupSaveConfig(patch));
      setMsg(note);
      setStatus(await backupStatus());
    } catch (e) { setErr(e instanceof Error ? e.message : 'save failed'); }
    finally { setBusy(false); }
  };
  const commitInterval = () => {
    const n = Number(intervalMin);
    if (!Number.isFinite(n) || n < 1) { setErr('interval must be at least 1 minute'); return; }
    if (cfg && Math.floor(n) !== cfg.fullIntervalMin) void save({ fullIntervalMin: Math.floor(n) }, `Backing up every ${Math.floor(n)} min`);
  };
  const runNow = async () => {
    setRunning(true); setErr(null); setMsg(null);
    try {
      const r = await backupRun();
      setMsg(r.ran
        ? `Wrote ${r.name} (${fmtBytes(r.bytes ?? 0)}, ${r.files ?? 0} files, ${Math.max(1, Math.round((r.durationMs ?? 0) / 1000))} s)`
        : 'A backup is already running');
    } catch (e) { setErr(e instanceof Error ? e.message : 'backup failed'); }
    finally { setRunning(false); await refresh(); }
  };
  const remove = async (name: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { await backupDelete(name); setMsg(`Deleted ${name}`); await refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'delete failed'); }
    finally { setBusy(false); }
  };
  const regen = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const { token } = await backupRegenerateToken();
      setCfg((c) => (c ? { ...c, token, configured: true } : c));
      setRevealed(true); setMsg('Backup token regenerated');
    } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); }
    finally { setBusy(false); }
  };
  const copy = (text: string) => {
    try { void navigator.clipboard.writeText(text); setMsg('Copied'); } catch { /* ignore */ }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const token = cfg?.token || '';
  const runCmd = `curl -X POST -H "Authorization: Bearer ${token || '<token>'}" ${origin}/api/backup/run`;
  const isRunning = running || !!status?.running;

  return (
    <div className="mb-4 rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-white/70">
        <HardDrive size={12} className="text-[hsl(var(--primary))]" /> Backups
      </div>
      <p className="mb-2 text-[10px] text-white/50">
        Consistent snapshots of the whole instance, written as one folder per run into the host folder below.
        Nothing is deleted automatically; remove old runs from the list when you want the space back.
      </p>

      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-white/50">Folder</span>
        <code className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] text-white/80">{cfg?.dir ?? status?.dir ?? '…'}</code>
        {status && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${status.dirWritable ? 'bg-[hsl(var(--status-green))]/15 text-[hsl(var(--status-green))]' : 'bg-[hsl(var(--status-red))]/15 text-[hsl(var(--status-red))]'}`}>
            {status.dirWritable ? 'writable' : 'not writable: check the ./backups bind mount'}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[11px] text-white/70">
          <input
            type="checkbox"
            checked={!!cfg?.enabled}
            disabled={!cfg || busy}
            onChange={(e) => save({ enabled: e.target.checked }, e.target.checked ? 'Scheduled backups on' : 'Scheduled backups off')}
          />
          Scheduled backups
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-white/70">
          every
          <input
            type="number"
            min={1}
            value={intervalMin}
            disabled={!cfg || busy}
            onChange={(e) => setIntervalMin(e.target.value)}
            onBlur={commitInterval}
            onKeyDown={(e) => { if (e.key === 'Enter') commitInterval(); }}
            className="w-16 rounded-md border border-white/15 bg-black/30 px-1.5 py-0.5 text-[11px] text-white/80 outline-none focus:border-[hsl(var(--primary))]"
          />
          min
        </label>
        <button
          type="button"
          onClick={runNow}
          disabled={!cfg || isRunning}
          className="flex items-center gap-1 rounded-md border border-[hsl(var(--primary))]/50 bg-[hsl(var(--primary))]/15 px-2 py-1 text-[11px] text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Play size={11} /> {isRunning ? 'Backing up…' : 'Back up now'}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {INCLUDE_LABELS.map((inc) => (
          <label key={inc.key} className="flex items-center gap-1.5 text-[11px] text-white/70" title={inc.hint}>
            <input
              type="checkbox"
              checked={cfg ? cfg.includes[inc.key] : true}
              disabled={!cfg || busy}
              onChange={(e) => save({ includes: { [inc.key]: e.target.checked } }, `${inc.label}: ${e.target.checked ? 'included' : 'excluded'}`)}
            />
            {inc.label}
          </label>
        ))}
      </div>
      {cfg && (!cfg.includes.sqlite || !cfg.includes.yjsShared) && (
        <p className="mt-1 text-[10px] text-[hsl(var(--status-amber))]">
          A backup without accounts or workspace metadata can only be restored with --partial on top of existing data.
        </p>
      )}

      {status && (
        <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 text-[10px] text-white/60 sm:grid-cols-2">
          <div>
            Last run: {fmtWhen(status.lastRunAt)}
            {status.lastError ? (
              <span className="text-[hsl(var(--status-red))]"> failed: {status.lastError}</span>
            ) : status.lastBackup ? (
              <span className="text-[hsl(var(--status-green))]"> ok, {fmtBytes(status.lastBackup.bytes)} in {Math.max(1, Math.round((status.lastBackup.durationMs ?? 0) / 1000))} s</span>
            ) : null}
          </div>
          <div>Next run: {status.enabled ? fmtUntil(status.nextRunAt) : 'schedule off'}</div>
          <div>On disk: {status.usage.count} backup{status.usage.count === 1 ? '' : 's'}, {fmtBytes(status.usage.totalBytes)}</div>
          {status.lastBackup && <div>Latest: <code className="text-white/70">{status.lastBackup.name}</code></div>}
        </div>
      )}

      {list.length > 0 && (
        <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-white/10">
          <table className="w-full text-[10px]">
            <tbody>
              {list.map((b) => (
                <tr key={b.name} className="border-b border-white/5 last:border-0">
                  <td className="px-2 py-1 font-mono text-white/80">{b.name}{b.partial ? <span className="ml-1 text-[hsl(var(--status-amber))]">(incomplete)</span> : null}</td>
                  <td className="px-2 py-1 text-white/50">{new Date(b.createdAt).toLocaleString()}</td>
                  <td className="px-2 py-1 text-right text-white/60">{fmtBytes(b.bytes)}</td>
                  <td className="px-2 py-1 text-right text-white/40">{b.files} files</td>
                  <td className="px-1 py-1 text-right">
                    <button
                      type="button"
                      onClick={() => setPendingRemove(b.name)}
                      disabled={busy}
                      title="Delete this backup"
                      className="rounded p-1 text-white/40 hover:bg-[hsl(var(--status-red))]/15 hover:text-[hsl(var(--status-red))] disabled:opacity-40"
                    >
                      <Trash2 size={11} />
                    </button>
                    {pendingRemove === b.name && (
                      <ConfirmDialog
                        title="Delete backup"
                        message={`Delete ${b.name}? This cannot be undone.`}
                        confirmLabel="Delete"
                        destructive
                        onCancel={() => setPendingRemove(null)}
                        onConfirm={() => { setPendingRemove(null); void remove(b.name); }}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-2 rounded-md border border-white/10 bg-black/20 p-2">
        <div className="mb-1 text-[10px] text-white/50">
          Host scheduler (optional): a Task Scheduler job, cron entry or systemd timer can trigger a run with this token instead of an admin login.
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <code className="flex-1 truncate rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-white/70">
            {cfg?.configured ? (revealed ? token : '•'.repeat(24)) : 'no token yet (enable backups or regenerate)'}
          </code>
          {cfg?.configured && (
            <button type="button" onClick={() => setRevealed((r) => !r)} className="text-[10px] text-white/60 hover:text-white">
              {revealed ? 'Hide' : 'Reveal'}
            </button>
          )}
          {cfg?.configured && (
            <button type="button" onClick={() => copy(runCmd)} title="Copy a curl command that runs a backup" className="flex items-center gap-1 text-[10px] text-white/60 hover:text-white">
              <Copy size={10} /> Copy curl
            </button>
          )}
          <button type="button" onClick={regen} disabled={busy} className="flex items-center gap-1 text-[10px] text-white/60 hover:text-white disabled:opacity-40">
            <RefreshCw size={10} /> Regenerate
          </button>
        </div>
        <div className="mt-1 text-[10px] text-white/40">
          Restore: stop the container, then <code>docker compose run --rm btct bun server/restore.mjs /backups/&lt;name&gt; --yes</code>, then start it. See README "Backups".
        </div>
      </div>

      {(msg || err) && (
        <div className={`mt-2 text-[10px] ${err ? 'text-[hsl(var(--status-red))]' : 'text-[hsl(var(--status-green))]'}`}>{err || msg}</div>
      )}
    </div>
  );
}

/**
 * Workspace-wide default strength for new blur (redaction) regions, one
 * value per style. A user who sets their own default in Edit Profile keeps
 * it; every other account follows these.
 */
function BlurConfigSection() {
  const blur = useThemeStore((s) => s.blurDefaults);
  const updateBlurDefaults = useThemeStore((s) => s.updateBlurDefaults);
  const [gaussian, setGaussian] = useState(1);
  const [pixelate, setPixelate] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setGaussian(blur.gaussian);
    setPixelate(blur.pixelate);
  }, [blur]);

  const dirty = gaussian !== blur.gaussian || pixelate !== blur.pixelate;
  const save = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await updateBlurDefaults({ gaussian, pixelate });
      setMsg('Blur defaults saved');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save failed');
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, hint: string, value: number, onChange: (n: number) => void) => (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-[11px] text-white/70" title={hint}>{label}</span>
      <input
        type="range"
        min={0.25}
        max={3}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-[hsl(var(--status-purple))]"
      />
      <span className="w-11 shrink-0 text-right font-mono text-[11px] text-white/70">{Math.round(value * 100)}%</span>
    </div>
  );

  return (
    <div className="mb-4 rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-white/70">
        <EyeOff size={12} className="text-[hsl(var(--status-purple))]" /> Blur Defaults
      </div>
      <p className="mb-2 text-[10px] text-white/50">
        Default strength for new redaction regions on report screenshots, per style.
        Users who set their own default in Edit Profile keep it; everyone else follows these.
      </p>
      <div className="space-y-2">
        {row('Blur', 'Smooth gaussian blur', gaussian, setGaussian)}
        {row('Pixels', 'Hard mosaic blocks', pixelate, setPixelate)}
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={() => { setGaussian(blur.gaussian); setPixelate(blur.pixelate); }}
          disabled={busy || !dirty}
          className="rounded-md px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-40"
        >
          Reset
        </button>
        <button
          onClick={() => void save()}
          disabled={busy || !dirty}
          className="rounded-md bg-white/90 px-3 py-1.5 text-xs font-medium text-black hover:bg-white disabled:opacity-40"
        >
          Save defaults
        </button>
      </div>
      {(msg || err) && (
        <div className={`mt-2 text-[11px] ${err ? 'text-[hsl(var(--status-red))]' : 'text-white/60'}`}>{err || msg}</div>
      )}
    </div>
  );
}
