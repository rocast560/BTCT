/**
 * Claude chat sessions store.
 *
 * Holds the *active* conversation in memory (so it survives closing/reopening
 * the Claude pane with no round-trip) plus the list of the account's saved
 * sessions. Durable storage is server-side (`/api/ai/sessions*`, per user), so
 * a browser refresh — or logging in elsewhere — restores everything. The only
 * thing kept in localStorage is a tiny pointer to the last-active session id so
 * a refresh lands you back in the chat you were in.
 */
import { create } from 'zustand';
import { useAuthStore, type ChatMessage, type ChatSessionMeta } from '@/auth/auth-store';

const DEFAULT_TITLE = 'New chat';

function pointerKey(uid: number | null): string | null {
  return uid == null ? null : `btct.ai.activeSession.${uid}`;
}
function readPointer(uid: number | null): string | null {
  const k = pointerKey(uid);
  if (!k) return null;
  try { return localStorage.getItem(k); } catch { return null; }
}
function writePointer(uid: number | null, id: string | null): void {
  const k = pointerKey(uid);
  if (!k) return;
  try { if (id) localStorage.setItem(k, id); else localStorage.removeItem(k); } catch { /* ignore */ }
}

function titleFrom(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 48) || DEFAULT_TITLE;
}

interface ChatState {
  list: ChatSessionMeta[];
  activeId: string | null;
  activeTitle: string;
  messages: ChatMessage[];
  loadedUserId: number | null;
  listLoading: boolean;

  refreshList: () => Promise<void>;
  /** Mount-time: refresh, then reopen the last chat (pointer → most recent → new). */
  init: () => Promise<void>;
  newChat: () => void;
  openSession: (id: string) => Promise<void>;
  addUserMessage: (text: string) => void;
  startAssistant: () => void;
  appendAssistant: (delta: string) => void;
  /** Persist the active session (title + messages). Called in send()'s finally. */
  finishTurn: () => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  list: [],
  activeId: null,
  activeTitle: DEFAULT_TITLE,
  messages: [],
  loadedUserId: null,
  listLoading: false,

  refreshList: async () => {
    const uid = useAuthStore.getState().user?.id ?? null;
    // Account switched in this browser → drop the previous user's chat state.
    if (get().loadedUserId !== uid) {
      set({ list: [], activeId: null, activeTitle: DEFAULT_TITLE, messages: [], loadedUserId: uid });
    }
    if (uid == null) { set({ list: [] }); return; }
    set({ listLoading: true });
    try {
      const sessions = await useAuthStore.getState().aiListSessions();
      set({ list: sessions, listLoading: false });
    } catch {
      set({ listLoading: false });
    }
  },

  init: async () => {
    await get().refreshList();
    if (get().activeId) return; // already have a live chat (pane was just reopened)
    const uid = useAuthStore.getState().user?.id ?? null;
    const pointer = readPointer(uid);
    if (pointer && get().list.some((s) => s.id === pointer)) {
      await get().openSession(pointer);
    } else if (get().list.length > 0) {
      const first = get().list[0];
      if (first) await get().openSession(first.id);
      else get().newChat();
    } else {
      get().newChat();
    }
  },

  newChat: () => {
    const uid = useAuthStore.getState().user?.id ?? null;
    const id = crypto.randomUUID();
    set({ activeId: id, activeTitle: DEFAULT_TITLE, messages: [] });
    writePointer(uid, id);
  },

  openSession: async (id) => {
    const uid = useAuthStore.getState().user?.id ?? null;
    try {
      const full = await useAuthStore.getState().aiGetSession(id);
      set({ activeId: full.id, activeTitle: full.title, messages: full.messages });
      writePointer(uid, full.id);
    } catch {
      get().newChat();
    }
  },

  addUserMessage: (text) => {
    if (!get().activeId) get().newChat();
    set((s) => {
      const isFirst = s.messages.length === 0;
      return {
        messages: [...s.messages, { role: 'user', content: text }],
        activeTitle: isFirst ? titleFrom(text) : s.activeTitle,
      };
    });
  },

  startAssistant: () => set((s) => ({ messages: [...s.messages, { role: 'assistant', content: '' }] })),

  appendAssistant: (delta) => set((s) => {
    const copy = s.messages.slice();
    const last = copy[copy.length - 1];
    if (last && last.role === 'assistant') copy[copy.length - 1] = { ...last, content: last.content + delta };
    return { messages: copy };
  }),

  finishTurn: async () => {
    const { activeId, activeTitle, messages } = get();
    if (!activeId || messages.length === 0) return;
    try {
      await useAuthStore.getState().aiSaveSession(activeId, { title: activeTitle, messages });
      await get().refreshList();
    } catch { /* keep it in memory; next successful turn re-saves */ }
  },

  renameSession: async (id, title) => {
    const t = title.trim().slice(0, 200) || DEFAULT_TITLE;
    try {
      const messages = get().activeId === id
        ? get().messages
        : (await useAuthStore.getState().aiGetSession(id)).messages;
      await useAuthStore.getState().aiSaveSession(id, { title: t, messages });
      if (get().activeId === id) set({ activeTitle: t });
      await get().refreshList();
    } catch { /* ignore */ }
  },

  deleteSession: async (id) => {
    try { await useAuthStore.getState().aiDeleteSession(id); } catch { /* ignore */ }
    const uid = useAuthStore.getState().user?.id ?? null;
    if (get().activeId === id) {
      set({ activeId: null, activeTitle: DEFAULT_TITLE, messages: [] });
      writePointer(uid, null);
    }
    await get().refreshList();
    if (!get().activeId) {
      const first = get().list[0];
      if (first) await get().openSession(first.id);
      else get().newChat();
    }
  },
}));
