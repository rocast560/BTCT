/**
 * In-app Claude assistant. Rendered as a normal tab/pane view (like Findings
 * or the Attack Timeline), so it can be split into its own pane, moved between
 * panes, and full-screened via the app's tab system. It talks to the
 * server-side agent (`POST /api/ai/chat`) which holds the API key and runs the
 * tool loop over the live workspace data. Responses stream via SSE and render
 * as markdown.
 *
 * Chat history is durable per account (see stores/chat-store.ts): the active
 * conversation lives in a store (survives closing/reopening the pane) and is
 * saved server-side (survives refresh, follows the account across devices).
 * "+ New chat" starts a fresh one; the History switcher revisits past sessions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Send, Loader2, Plus, History, ChevronDown, Pencil, Trash2 } from 'lucide-react';
import { useAppStore } from '@/stores';
import { useAuthStore, type AiConfig } from '@/auth/auth-store';
import { useChatStore } from '@/stores/chat-store';
import { Markdown } from './markdown';

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

function relTime(ts: number): string {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function AiAssistant() {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const messages = useChatStore((s) => s.messages);
  const list = useChatStore((s) => s.list);
  const activeId = useChatStore((s) => s.activeId);

  const [config, setConfig] = useState<AiConfig | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [toolNote, setToolNote] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void useAuthStore.getState().aiGetConfig().then(setConfig).catch(() => setConfig(null));
    void useChatStore.getState().init();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming, toolNote]);

  // ── Streaming: batch SSE deltas and flush on animation frames into the store
  // so markdown re-parses at most ~once per frame instead of once per token. ──
  const bufferRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const flush = useCallback(() => {
    rafRef.current = null;
    const chunk = bufferRef.current;
    if (!chunk) return;
    bufferRef.current = '';
    useChatStore.getState().appendAssistant(chunk);
  }, []);
  const appendText = useCallback((delta: string) => {
    bufferRef.current += delta;
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush);
  }, [flush]);
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    const chat = useChatStore.getState();
    chat.addUserMessage(text);
    chat.startAssistant();
    // History up to and including the new user turn (exclude the empty assistant placeholder).
    const history = useChatStore.getState().messages.slice(0, -1);
    setInput('');
    setStreaming(true);
    setToolNote(null);

    try {
      const token = useAuthStore.getState().token;
      const res = await fetch(`${API}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ messages: history.map((m) => ({ role: m.role, content: m.content })), workspaceId: activeWorkspaceId }),
      });
      if (!res.ok || !res.body) {
        appendText(`⚠️ ${(await res.text().catch(() => '')) || `request failed (${res.status})`}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let ev: { type: string; text?: string; name?: string; error?: string };
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === 'text' && ev.text) { setToolNote(null); appendText(ev.text); }
          else if (ev.type === 'tool' && ev.name) setToolNote(`Running ${ev.name}…`);
          else if (ev.type === 'error' && ev.error) appendText(`\n\n⚠️ ${ev.error}`);
        }
      }
    } catch (e) {
      appendText(`\n\n⚠️ ${e instanceof Error ? e.message : 'stream failed'}`);
    } finally {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      flush();
      setStreaming(false);
      setToolNote(null);
      void useChatStore.getState().finishTurn(); // persist the turn (even if it errored)
    }
  };

  const disabled = config && !config.enabled;

  return (
    <div className="flex h-full flex-col bg-[hsl(var(--background))]">
      <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles size={14} className="text-[hsl(var(--primary))]" />
          <span className="text-[11px] font-bold uppercase tracking-widest">Claude</span>
          {config && (
            <span className={`rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${config.mode === 'edit' ? 'bg-[hsl(var(--primary))]/15 text-[hsl(var(--primary))]' : 'bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]'}`}>
              {config.mode === 'edit' ? 'Edit' : 'View'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { useChatStore.getState().newChat(); setHistoryOpen(false); }}
            className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2 py-1 text-[10px] hover:bg-[hsl(var(--accent))]"
            title="Start a new chat"
          >
            <Plus size={12} /> New chat
          </button>
          <div className="relative">
            <button
              onClick={() => setHistoryOpen((o) => !o)}
              className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2 py-1 text-[10px] hover:bg-[hsl(var(--accent))]"
              title="Chat history"
            >
              <History size={12} /> History <ChevronDown size={10} />
            </button>
            {historyOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setHistoryOpen(false)} />
                <div className="absolute right-0 z-50 mt-1 max-h-[60vh] w-72 overflow-y-auto rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-1 shadow-2xl">
                  {list.length === 0 ? (
                    <div className="px-2 py-4 text-center text-[10px] text-[hsl(var(--muted-foreground))]">No saved chats yet.</div>
                  ) : (
                    list.map((s) => (
                      <div
                        key={s.id}
                        onClick={() => { void useChatStore.getState().openSession(s.id); setHistoryOpen(false); }}
                        className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] hover:bg-[hsl(var(--accent))] ${s.id === activeId ? 'bg-[hsl(var(--accent))]/60' : ''}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{s.title}</div>
                          <div className="text-[9px] text-[hsl(var(--muted-foreground))]">{relTime(s.updatedAt)}</div>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); const t = window.prompt('Rename chat', s.title); if (t != null) void useChatStore.getState().renameSession(s.id, t); }}
                          className="hidden rounded p-0.5 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] group-hover:block"
                          title="Rename"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${s.title}"?`)) void useChatStore.getState().deleteSession(s.id); }}
                          className="hidden rounded p-0.5 text-[hsl(var(--status-red))] hover:bg-[hsl(var(--status-red))]/10 group-hover:block"
                          title="Delete"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="mx-auto w-full max-w-3xl flex-1 space-y-3 overflow-y-auto p-4">
        {disabled && (
          <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3 text-xs text-[hsl(var(--muted-foreground))]">
            The assistant isn't enabled yet. An admin can add an Anthropic API key and enable it in the Admin panel.
          </div>
        )}
        {!disabled && messages.length === 0 && (
          <div className="px-1 py-10 text-center text-[11px] text-[hsl(var(--muted-foreground))]">
            Ask about your notes, graphs, findings, or nmap scans.<br />
            e.g. "What's exposed in the latest scan and what should we hit first?"
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            {m.role === 'user' ? (
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[hsl(var(--primary))] px-3 py-2 text-xs leading-relaxed text-[hsl(var(--primary-foreground))]">
                {m.content}
              </div>
            ) : (
              <div className="max-w-[90%] rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs leading-relaxed">
                {m.content ? <Markdown text={m.content} /> : (streaming && i === messages.length - 1 ? <span className="text-[hsl(var(--muted-foreground))]">…</span> : null)}
              </div>
            )}
          </div>
        ))}
        {toolNote && (
          <div className="flex items-center gap-1.5 px-1 text-[10px] text-[hsl(var(--muted-foreground))]">
            <Loader2 size={11} className="animate-spin" /> {toolNote}
          </div>
        )}
      </div>

      <div className="border-t border-[hsl(var(--border))] p-2">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={disabled ? 'Assistant disabled' : 'Ask Claude…'}
            rows={2}
            disabled={!!disabled || streaming}
            className="flex-1 resize-none rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--card))] px-2.5 py-2 text-xs outline-none focus:border-[hsl(var(--primary))] disabled:opacity-50"
          />
          <button
            onClick={() => void send()}
            disabled={!!disabled || streaming || !input.trim()}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-40"
            title="Send"
          >
            {streaming ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
