import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Portal } from '@/components/ui/Portal';
import { cn } from '@/lib/utils';

/**
 * The app's replacement for `window.confirm` / `window.prompt`: a themed sheet
 * in a body portal (see Portal.tsx) instead of the browser's own dialog,
 * which ignores the theme entirely. With `input` set it asks for a value
 * (Enter confirms, Escape cancels); otherwise it is a plain yes/no.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  destructive = false,
  input,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: string;
  confirmLabel?: string;
  destructive?: boolean;
  /** Ask for a text value; `initial` prefills it. */
  input?: { initial?: string; placeholder?: string };
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(input?.initial ?? '');
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!input) confirmRef.current?.focus();
  }, [input]);

  const submit = () => {
    if (input && !value.trim()) return;
    onConfirm(value.trim());
  };

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4"
        onClick={onCancel}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="w-full max-w-sm rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className={cn('mb-2 flex items-center gap-2 text-sm font-semibold', destructive && 'text-[hsl(var(--status-red))]')}>
            {destructive && <AlertTriangle size={16} />}
            {title}
          </div>
          {message && <p className="mb-4 text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">{message}</p>}
          {input && (
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder={input.placeholder}
              className="mb-4 w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
            />
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
            >
              Cancel
            </button>
            <button
              ref={confirmRef}
              type="button"
              onClick={submit}
              disabled={!!input && !value.trim()}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50',
                destructive
                  ? 'bg-[hsl(var(--status-red))] text-white hover:opacity-90'
                  : 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90',
              )}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
