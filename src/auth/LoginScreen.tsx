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
        className="w-full max-w-sm rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-7 shadow-2xl"
      >
        <div className="mb-5 flex items-center gap-2">
          <img src="/new-logo.png" alt="" className="h-7 w-7 rounded-md object-cover" />
          <h1 className="text-lg font-semibold tracking-tight">Been There, Conquered That</h1>
        </div>
        <p className="mb-6 text-sm text-[hsl(var(--muted-foreground))]">Sign in to your workspace</p>

        <label className="mb-3 block text-sm">
          <span className="mb-1.5 block text-xs font-medium text-[hsl(var(--muted-foreground))]">Username</span>
          <input
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 outline-none transition-colors focus:border-[hsl(var(--primary))]"
          />
        </label>
        <label className="mb-4 block text-sm">
          <span className="mb-1.5 block text-xs font-medium text-[hsl(var(--muted-foreground))]">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 outline-none transition-colors focus:border-[hsl(var(--primary))]"
          />
        </label>

        {error && (
          <div className="mb-3 rounded-lg border border-[hsl(var(--destructive))]/40 bg-[hsl(var(--destructive))]/10 px-3 py-2 text-sm text-[hsl(var(--destructive))]">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-[hsl(var(--primary))] px-3 py-2 text-sm font-semibold text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Log in'}
        </button>

        <p className="mt-5 text-center text-xs text-[hsl(var(--muted-foreground))]">
          Accounts are created by an administrator from inside the app.
        </p>
      </form>
    </div>
  );
}
