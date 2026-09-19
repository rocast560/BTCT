// The report source is the one Y.Text in the shared doc with no repo
// `create()` behind it: the tab that opens it is what seeds it. Seeding
// before the doc has synced writes a SECOND Y.Text into the `texts` slot,
// and Yjs resolves two concurrent map writes by client id, so half the time
// the starter template wins and the real report (which has no version
// history) is gone. These tests pin the seed to `whenReady`.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import { DEFAULT_TYPST_TEMPLATE } from '@/lib/typst-template';

const shared = vi.hoisted(() => ({ current: null as unknown }));

// A stand-in for the real shared doc: a bare Y.Doc plus a `whenReady` this
// test resolves by hand. `getOrInitYText` keeps the real module's semantics
// (return what is already in the slot, seed only when the slot is empty).
vi.mock('@/realtime/shared-doc', async () => {
  const Yjs = await import('yjs');
  interface FakeShared { doc: Y.Doc; texts: Y.Map<Y.Text>; whenReady: Promise<void> }
  const ctx = () => shared.current as FakeShared;
  return {
    getSharedDoc: () => ctx(),
    textKey: (entity: string, id: string, field: string) => `${entity}:${id}:${field}`,
    getOrInitYText: (key: string, initial: string) => {
      const c = ctx();
      const existing = c.texts.get(key);
      if (existing) return existing;
      let created: Y.Text | undefined;
      c.doc.transact(() => {
        created = c.texts.get(key);
        if (!created) {
          created = new Yjs.Text();
          if (initial) created.insert(0, initial);
          c.texts.set(key, created);
        }
      });
      return c.texts.get(key) ?? created!;
    },
  };
});

import { useTypstSource } from '@/components/typst/use-typst-source';

const KEY = 'typst:ws-1:source';

let doc: Y.Doc;
let texts: Y.Map<Y.Text>;
let ready: () => void;

beforeEach(() => {
  doc = new Y.Doc();
  texts = doc.getMap<Y.Text>('texts');
  let resolve!: () => void;
  const whenReady = new Promise<void>((r) => { resolve = r; });
  ready = resolve;
  shared.current = { doc, texts, whenReady };
});

describe('useTypstSource seeding', () => {
  it('writes nothing into the texts map until the shared doc is ready', async () => {
    const { result } = renderHook(() => useTypstSource('ws-1'));

    expect(texts.has(KEY)).toBe(false);
    expect(result.current).toBeNull();

    ready();
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(texts.has(KEY)).toBe(true);
    expect(texts.get(KEY)!.toString()).toBe(DEFAULT_TYPST_TEMPLATE);
    expect(result.current).toBe(texts.get(KEY));
  });

  it('adopts a text that syncs in before readiness and never seeds over it', async () => {
    const { result } = renderHook(() => useTypstSource('ws-1'));

    // The websocket delivers the workspace's real report while the hook is
    // still waiting: the map observer adopts it.
    const remote = new Y.Text();
    remote.insert(0, '= The real report\n');
    doc.transact(() => texts.set(KEY, remote));

    await waitFor(() => expect(result.current).toBe(remote));

    ready();
    // The seed that runs after readiness finds the slot populated and hands
    // back the same Y.Text rather than replacing it with the template.
    await waitFor(() => expect(texts.get(KEY)).toBe(remote));
    expect(texts.get(KEY)!.toString()).toBe('= The real report\n');
    expect(result.current).toBe(remote);
  });

  it('drops the previous workspace text when the workspace changes', async () => {
    const { result, rerender } = renderHook((id: string) => useTypstSource(id), {
      initialProps: 'ws-1',
    });
    ready();
    await waitFor(() => expect(result.current).not.toBeNull());
    const first = result.current;

    rerender('ws-2');
    expect(result.current).toBeNull();
    expect(result.current).not.toBe(first);
  });
});
