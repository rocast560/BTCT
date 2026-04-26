/**
 * React binding for a collaborative text field backed by a Y.Text.
 *
 * This is the same pattern Google Docs / Notion / Linear use under the
 * hood: every keystroke is converted into an *insert/delete delta* on a
 * shared CRDT, not a wholesale string overwrite. That's what makes
 * concurrent edits ("user A and user B type into the same field at the
 * same time") merge character-by-character with no data loss.
 *
 * Usage:
 *
 *   const [value, onChange, ref] = useYTextInput(
 *     textKey('page', pageId, 'title'),
 *     page.title,
 *   );
 *   <input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} />
 *
 * The `ref` is optional — if you pass it, the hook restores the cursor
 * position after remote edits so a remote user typing in the same field
 * doesn't kick your caret to the end of the line.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { getOrInitYText, sharedTransact } from './shared-doc';

/**
 * Compute the minimal (delete, insert) pair that turns `oldStr` into
 * `newStr`. Trims a common prefix and a common suffix so we only emit
 * the smallest possible delta — this keeps remote inserts targeted and
 * preserves the cursor of any concurrent typer naturally.
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

/**
 * Subscribe to a Y.Text and get back its current string + a setter that
 * applies a minimal delta (insert / delete) to the CRDT. The hook also
 * preserves the local input's caret position when a remote edit arrives.
 */
export function useYTextInput(
  key: string,
  initial: string,
): [
  value: string,
  onChange: (next: string) => void,
  inputRef: React.MutableRefObject<HTMLInputElement | null>,
] {
  const ytext = getOrInitYText(key, initial);
  const [value, setValue] = useState<string>(() => ytext.toString());
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Track whether the most recent change came from this hook's onChange
  // (local) so we don't fight the React-controlled input over its own
  // value during the same tick.
  const localOriginRef = useRef(false);

  useEffect(() => {
    const handler = (_ev: Y.YTextEvent, tr: Y.Transaction) => {
      const next = ytext.toString();
      const isLocal = tr.local;
      // Capture caret BEFORE setState if the input is focused and the
      // remote edit happened entirely outside the user's selection.
      const el = inputRef.current;
      const wasFocused = !!el && document.activeElement === el;
      const prevSel = wasFocused
        ? { start: el!.selectionStart ?? 0, end: el!.selectionEnd ?? 0 }
        : null;
      const prev = value;

      setValue(next);

      // After React flushes the new value, restore the caret position,
      // shifting it if the remote edit happened before the caret.
      if (wasFocused && prevSel && !isLocal) {
        const d = diff(prev, next);
        let { start, end } = prevSel;
        if (d) {
          if (d.index <= start) {
            const shift = d.insert.length - d.remove;
            start = Math.max(d.index, start + shift);
            end = Math.max(d.index, end + shift);
          } else if (d.index < end) {
            // Remote edit happened inside the selection — collapse to
            // the local edit point. Rare; harmless.
            end = d.index;
          }
        }
        // Defer to the next tick so React's value update lands first.
        queueMicrotask(() => {
          const e2 = inputRef.current;
          if (!e2) return;
          try {
            e2.setSelectionRange(start, end);
          } catch {
            // Some input types (e.g. number) don't support setSelectionRange.
          }
        });
      }
      localOriginRef.current = false;
    };
    ytext.observe(handler);
    // Initial sync in case the Y.Text was updated between hook mount and
    // observer registration.
    setValue(ytext.toString());
    return () => ytext.unobserve(handler);
    // We intentionally depend on `key` only — re-binding when `value`
    // changes would create infinite loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const onChange = useCallback(
    (next: string) => {
      const cur = ytext.toString();
      const d = diff(cur, next);
      if (!d) return;
      localOriginRef.current = true;
      sharedTransact(() => {
        if (d.remove > 0) ytext.delete(d.index, d.remove);
        if (d.insert.length > 0) ytext.insert(d.index, d.insert);
      });
      // Optimistically update local React state so the controlled input
      // stays in sync without waiting for the observer round-trip.
      setValue(next);
    },
    [ytext],
  );

  return [value, onChange, inputRef];
}
