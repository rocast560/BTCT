import { useEffect, useState } from 'react';
import { Shield, X, Trash2, Plus, KeyRound } from 'lucide-react';
import { useAuthStore, type AdminUserRow } from '@/auth/auth-store';

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
            <Shield size={16} className="text-amber-400" />
            <h2 className="text-sm font-semibold">Admin Panel — Users</h2>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-white/10" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {error && (
            <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          {/* Create-user form */}
          <form
            onSubmit={submitCreate}
            className="mb-4 rounded border border-white/10 bg-black/20 p-3"
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
                className="rounded border border-white/10 bg-black/40 px-2 py-1.5 text-sm outline-none focus:border-white/30"
              />
              <input
                type="password"
                placeholder="Password (min 8)"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="rounded border border-white/10 bg-black/40 px-2 py-1.5 text-sm outline-none focus:border-white/30"
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
                className="rounded bg-white/90 px-3 py-1 text-xs font-medium text-black hover:bg-white disabled:opacity-50"
              >
                {busy ? 'Working…' : 'Create'}
              </button>
            </div>
          </form>

          {/* User list */}
          <div className="overflow-hidden rounded border border-white/10">
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
                            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase text-white/60">
                              you
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {u.isAdmin ? (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] uppercase text-amber-300">
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
                              className="w-32 rounded border border-white/10 bg-black/40 px-2 py-1 text-xs outline-none focus:border-white/30"
                            />
                            <button
                              onClick={() => void submitReset(u.id)}
                              disabled={busy}
                              className="rounded bg-white/90 px-2 py-1 text-[11px] font-medium text-black hover:bg-white disabled:opacity-50"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => { setResettingId(null); setResetPwd(''); }}
                              className="rounded px-2 py-1 text-[11px] text-white/60 hover:bg-white/10"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => { setResettingId(u.id); setResetPwd(''); }}
                              className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"
                              title="Reset password"
                            >
                              <KeyRound size={13} />
                            </button>
                            <button
                              onClick={() => void submitDelete(u.id, u.username)}
                              disabled={isSelf}
                              className="rounded p-1 text-red-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-30"
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
