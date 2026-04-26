import { useState } from 'react';
import { useAuthStore } from './auth-store';

/**
 * Login + register screen shown when no user is authenticated. Renders a
 * centered card with a tab switch between login and signup. On success the
 * auth store flips to "authenticated" and `<App>` renders the workspace.
 */
export function LoginScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim()) {
      setError('username is required');
      return;
    }
    if (password.length < 8) {
      setError('password must be at least 8 characters');
      return;
    }
    if (mode === 'register' && password !== confirm) {
      setError('passwords do not match');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(username.trim(), password);
      } else {
        await register(username.trim(), password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex h-screen w-screen items-center justify-center bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-white/10 bg-black/30 p-6 shadow-xl"
      >
        <h1 className="mb-1 text-xl font-semibold">Alysa</h1>
        <p className="mb-5 text-sm text-white/60">
          {mode === 'login' ? 'Sign in to your workspace' : 'Create an account'}
        </p>

        <div className="mb-4 flex rounded-md border border-white/10 p-1 text-sm">
          <button
            type="button"
            className={`flex-1 rounded px-3 py-1.5 ${mode === 'login' ? 'bg-white/10' : 'text-white/60 hover:text-white'}`}
            onClick={() => setMode('login')}
          >
            Log in
          </button>
          <button
            type="button"
            className={`flex-1 rounded px-3 py-1.5 ${mode === 'register' ? 'bg-white/10' : 'text-white/60 hover:text-white'}`}
            onClick={() => setMode('register')}
          >
            Sign up
          </button>
        </div>

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
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
          />
        </label>
        {mode === 'register' && (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-white/70">Confirm password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
            />
          </label>
        )}

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
          {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </form>
    </div>
  );
}
