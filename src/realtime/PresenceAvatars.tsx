/**
 * Floating "active users" window — the entry point for live-following a
 * teammate. Toggled by the `openFollowPanel` keybind (default Ctrl/⌘+Shift+U)
 * or the command palette, via the `followPanelOpen` store flag.
 *
 * Lists online teammates and what each is looking at, with a Follow / Stop
 * toggle. When you follow while your layout is split for the first time, a
 * one-off prompt asks whether the followed view should slot into one of your
 * panes or take over the screen; the choice is remembered in your profile.
 */
import { useState } from 'react';
import { X, Users, Eye, EyeOff } from 'lucide-react';
import { useAppStore } from '@/stores';
import { useAuthStore, type AuthUser } from '@/auth/auth-store';
import { resolvePrefs } from '@/lib/editor-prefs';
import { isSplit } from '@/lib/pane-layout';
import type { TabKind } from '@/types';
import { usePresenceRoster, type PeerPresence } from './presence';

const KIND_LABEL: Record<TabKind, string> = {
  page: 'Page',
  graph: 'Graph',
  nmap: 'Nmap',
  'nmap-machine': 'Host',
  findings: 'Findings',
  timeline: 'Timeline',
  typst: 'Typst',
  ai: 'Claude',
  cmdlog: 'Command Log',
};

function whereLabel(peer: PeerPresence): string {
  const f = peer.focus;
  if (!f) return 'Idle';
  const kind = KIND_LABEL[f.kind] ?? f.kind;
  return f.title ? `${kind} · ${f.title}` : kind;
}

export function PresenceAvatars() {
  const open = useAppStore((s) => s.followPanelOpen);
  const setOpen = useAppStore((s) => s.setFollowPanelOpen);
  const followingUserId = useAppStore((s) => s.followingUserId);
  const setFollowingUserId = useAppStore((s) => s.setFollowingUserId);
  const user = useAuthStore((s) => s.user) as AuthUser;
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const peers = usePresenceRoster();

  // Which peer id is awaiting a pane-placement choice (first split-follow).
  const [promptFor, setPromptFor] = useState<number | null>(null);

  if (!open) return null;

  const handleFollow = (peer: PeerPresence) => {
    if (followingUserId === peer.user.id) {
      setFollowingUserId(null);
      return;
    }
    const placement = resolvePrefs(user).follow.panePlacement;
    if (isSplit(useAppStore.getState().paneLayout) && placement === null) {
      setPromptFor(peer.user.id);
      return;
    }
    setFollowingUserId(peer.user.id);
  };

  const choosePlacement = async (choice: 'split' | 'takeover', peerId: number) => {
    const resolved = resolvePrefs(user);
    try {
      await updateProfile({
        prefs: {
          codeAccent: resolved.codeAccent,
          keybinds: resolved.keybinds,
          follow: { ...resolved.follow, panePlacement: choice },
          theme: resolved.theme,
        },
      });
    } catch {
      /* non-fatal: still follow this session even if the pref didn't persist */
    }
    setPromptFor(null);
    setFollowingUserId(peerId);
  };

  return (
    <div className="fixed right-4 top-14 z-50 w-72 overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-2xl">
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Users size={14} className="text-[hsl(var(--primary))]" />
          <span className="text-[11px] font-bold uppercase tracking-widest">Active Users</span>
        </div>
        <button onClick={() => setOpen(false)} className="rounded-md p-1 hover:bg-[hsl(var(--accent))]" title="Close">
          <X size={14} />
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto p-2">
        {peers.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-[hsl(var(--muted-foreground))]">
            No other users online.
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {peers.map((peer) => {
              const isFollowing = followingUserId === peer.user.id;
              const isPrompting = promptFor === peer.user.id;
              return (
                <li
                  key={peer.user.id}
                  className="rounded-lg border border-transparent px-2 py-1.5 hover:border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]/40"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: peer.user.color }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{peer.user.name}</div>
                      <div className="truncate text-[10px] text-[hsl(var(--muted-foreground))]">
                        {whereLabel(peer)}
                      </div>
                    </div>
                    <button
                      onClick={() => handleFollow(peer)}
                      disabled={!peer.focus && !isFollowing}
                      title={isFollowing ? 'Stop following' : 'Follow'}
                      className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-40 ${
                        isFollowing
                          ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/15 text-[hsl(var(--primary))]'
                          : 'border-[hsl(var(--border))] hover:border-[hsl(var(--primary))]/60'
                      }`}
                    >
                      {isFollowing ? <EyeOff size={11} /> : <Eye size={11} />}
                      {isFollowing ? 'Stop' : 'Follow'}
                    </button>
                  </div>

                  {isPrompting && (
                    <div className="mt-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-2">
                      <p className="mb-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">
                        You have split panes. Where should followed views go?
                      </p>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => void choosePlacement('split', peer.user.id)}
                          className="flex-1 rounded-md border border-[hsl(var(--border))] px-2 py-1 text-[10px] hover:border-[hsl(var(--primary))]/60"
                        >
                          Into a pane
                        </button>
                        <button
                          onClick={() => void choosePlacement('takeover', peer.user.id)}
                          className="flex-1 rounded-md border border-[hsl(var(--border))] px-2 py-1 text-[10px] hover:border-[hsl(var(--primary))]/60"
                        >
                          Take over
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-[hsl(var(--border))] px-3 py-2 text-[10px] text-[hsl(var(--muted-foreground))]">
        Set per-teammate precision in Profile → Following.
      </div>
    </div>
  );
}
