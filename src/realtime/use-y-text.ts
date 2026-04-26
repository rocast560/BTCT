/**
 * React binding for a collaborative text field backed by a Y.Text.
 *
 * This is the same pattern Google Docs / Notion / Linear use under the
 * hood: every keystroke is converted into an *insert/delete delta* on a
 * shared CRDT, not a wholesale string overwrite. Concurrent edits on
 * different machines merge character-by-character with no data loss.
 *
 * Two clients that both seed a Y.Text into the same map slot will, after
 * sync, end up with one *winning* Y.Text in the map and the other one
 * orphaned. To handle that, this hook also observes the parent `texts`
 * map: if the slot for our key gets replaced, we re-read the Y.Text,
 * rebind the value-observer to it, and refresh local state. Without
 * this, the late-arriving client would be wedged onto a dead reference
 * and never see remote edits.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { getOrInitYText, getSharedDoc, sharedTransact } from './shared-doc';

/**
 * Compute the minimal (delete, insert) pair that turns `oldStr` into
 * `newStr`. Trims a common prefix and a common suffix so we only emit
 * the smallest possible delta.
 */
function diff(oldStr: string, newStr: string): { index: number; remove: number; insert: string } | null {
  if (oldStr === newStr) return null;
  let start = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (start < minLen && oldStr.charCodeAt(start) === newStr.charCodeAt(start)) start++;
  let oldEnd = oldStr.length;
  let newEnd = newStr.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldStr.charCodeAt(oldEnd - 1) === newStr.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }
  return {
    index: start,
    remove: oldEnd - start,
    insert: newStr.slice(start, newEnd),
  };
}

export function useYTextInput(
  key: string,
  initial: string,
): [
  value: string,
  onChange: (next: string) => void,
  inputRef: React.MutableRefObject<HTMLInputElement | null>,
] {
  // The currently-bound Y.Text. Held in a ref because it can be replaced
  // out from under us if a concurrent peer wins the map-slot race.
  const ytextRef = useRef<Y.Text>(getOrInitYText(key, initial));
  const [value, setValue] = useState<string>(() => ytextRef.current.toString());
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const sharedTexts = getSharedDoc().texts;
    let currentText = getOrInitYText(key, initial);
    ytextRef.current = currentText;
    setValue(currentText.toString());

    const restoreCaret = (prev: string, next: string, isLocal: boolean) => {
      const el = inputRef.current;
      if (!el || document.activeElement !== el || isLocal) return;
      const start0 = el.selectionStart ?? 0;
      const end0 = el.selectionEnd ?? 0;
      const d = diff(prev, next);
      let start = start0;
      let end = end0;
      if (d) {
        if (d.index <= start) {
          const shift = d.insert.length - d.remove;
          start = Math.max(d.index, start + shift);
          end = Math.max(d.index, end + shift);
        } else if (d.index < end) {
          end = d.index;
        }
      }
      queueMicrotask(() => {
        const e2 = inputRef.current;
        if (!e2) return;
        try {
          e2.setSelectionRange(start, end);
        } catch {
          /* number/email inputs don't support selection range */
        }
      });
    };

    const onTextChange = (_ev: Y.YTextEvent, tr: Y.Transaction) => {
      const prev = currentText.toString();
      // Y.Text observer fires AFTER the change is applied, so we have
      // to capture `prev` from a snapshot via the event delta. Simpler:
      // re-derive from the React state.
      const next = currentText.toString();
      // Use React state as the "before" value for caret math.
      restoreCaret(value, next, tr.local);
      setValue(next);
      // touch prev to silence unused warning
      void prev;
    };

    currentText.observe(onTextChange);

    // Observer for the parent texts map: detect when *our* key's slot
    // gets replaced by a remote peer's winning Y.Text, then rebind.
    const onMapChange = (ev: Y.YMapEvent<Y.Text>) => {
      if (!ev.changes.keys.has(key)) return;
      const next = sharedTexts.get(key);
      if (!next || next === currentText) return;
      currentText.unobserve(onTextChange);
      currentText = next;
      ytextRef.current = next;
      next.observe(onTextChange);
      setValue(next.toString());
    };
    sharedTexts.observe(onMapChange);

    return () => {
      currentText.unobserve(onTextChange);
      sharedTexts.unobserve(onMapChange);
    };
    // We deliberately don't depend on `initial` or `value` here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const onChange = useCallback(
    (next: string) => {
      const t = ytextRef.current;
      const cur = t.toString();
      const d = diff(cur, next);
      if (!d) return;
      sharedTransact(() => {
        if (d.remove > 0) t.delete(d.index, d.remove);
        if (d.insert.length > 0) t.insert(d.index, d.insert);
      });
      setValue(next);
    },
    [],
  );

  return [value, onChange, inputRef];
}
