// ─────────────────────────────────────────────────────────────────────────
// The report's source Y.Text: one per workspace, keyed
// `typst:<workspaceId>:source`.
//
// Split out of TypstView so the seeding rule can be unit-tested on its own,
// without the editor, the preview and the compiler coming with it.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { getSharedDoc, getOrInitYText, textKey } from '@/realtime/shared-doc';
import { DEFAULT_TYPST_TEMPLATE } from '@/lib/typst-template';

/**
 * Bind to the per-workspace Typst source Y.Text, seeding it on first open.
 *
 * The seed waits for the shared doc's `whenReady` (IndexedDB replay plus the
 * websocket's first sync, hard-capped at 4 s) because the report is the one
 * Y.Text with no repo `create()` behind it: the tab that opens it is what
 * seeds it. Seeding on mount instead writes a SECOND Y.Text into the slot
 * whenever the local doc is still cold, and Yjs resolves two concurrent map
 * writes by client id, so half the time the starter template wins and the
 * real report (which has no version history) is gone. `realtime/use-y-text.ts`
 * documents the same footgun for input fields.
 *
 * Until that resolves the hook returns null and the tab shows its loading
 * state. A text that syncs in during the wait is adopted by the map
 * observer, and the seed that runs afterwards finds the key populated, so
 * `getOrInitYText` hands back that same Y.Text instead of seeding over it.
 */
export function useTypstSource(workspaceId: string): Y.Text | null {
  const [ytext, setYtext] = useState<Y.Text | null>(null);

  useEffect(() => {
    let cancelled = false;
    const key = textKey('typst', workspaceId, 'source');
    const shared = getSharedDoc();
    const texts = shared.texts;
    // A workspace switch must never leave the previous workspace's report on
    // screen (and editable) under the new key.
    setYtext(null);
    let current: Y.Text | null = null;

    // Rebind if the canonical Y.Text in the slot arrives, or is replaced, via
    // sync (the rare two-clients-seed-at-once case) so we never edit an
    // orphan.
    const onMapChange = (ev: Y.YMapEvent<Y.Text>) => {
      if (!ev.changes.keys.has(key)) return;
      const next = texts.get(key);
      if (next && next !== current) {
        current = next;
        setYtext(next);
      }
    };
    texts.observe(onMapChange);

    void shared.whenReady.then(() => {
      if (cancelled) return;
      // Seeds the starter template only when sync brought nothing. An
      // intentionally-cleared report keeps an empty Y.Text, so it is not
      // re-seeded either.
      current = getOrInitYText(key, DEFAULT_TYPST_TEMPLATE);
      setYtext(current);
    });

    return () => {
      cancelled = true;
      texts.unobserve(onMapChange);
    };
  }, [workspaceId]);

  return ytext;
}
