import { useState } from 'react';
import { useAuthStore } from './auth-store';

/**
 * Sign-in screen shown when no user is authenticated. Self-service signup
 * is disabled — only an administrator can create accounts via the in-app
 * admin panel. A bootstrap admin is provisioned by the server on first
 * launch (see server/index.mjs ensureBootstrapAdmin).
 */
export function LoginScreen() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = useAuthStore((s) => s.login);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim()) {
      setError('username is required');
      return;
    }
    if (!password) {
      setError('password is required');
      return;
    }
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-white/10 bg-black/30 p-6 shadow-xl"
      >
        <h1 className="mb-1 text-xl font-semibold">SYNote</h1>
        <p className="mb-5 text-sm text-white/60">Sign in to your workspace</p>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-white/70">Username</span>
          <input
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
          />
        </label>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-white/70">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
          />
        </label>

        {error && (
          <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-white/90 px-3 py-2 text-sm font-medium text-black hover:bg-white disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Log in'}
        </button>

        <p className="mt-4 text-center text-xs text-white/40">
          Accounts are created by an administrator from inside the app.
        </p>
      </form>
    </div>
  );
}
