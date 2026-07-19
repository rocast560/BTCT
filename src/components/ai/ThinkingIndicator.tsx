// ─────────────────────────────────────────────────────────────────────────
// Activity indicator for the Claude assistant.
//
// The agent loop can run for a while without producing any text: the model
// thinks, calls a workspace tool, reads the result, thinks again — up to a
// dozen rounds. Without a signal, all of that looks like the app has hung.
//
// The indicator names what's actually happening (thinking / running a
// specific tool / reading results), counts the research steps once the run
// stops being a one-shot answer, and shows elapsed time after a few seconds
// so a long wait feels accounted for rather than stuck.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Brain, Wrench } from 'lucide-react';

/** What the agent is doing right now, derived from the SSE stream. */
export type AgentPhase =
  | { kind: 'idle' }
  /** Waiting on the model — before any text, or between tool rounds. */
  | { kind: 'thinking' }
  /** A workspace tool is executing. */
  | { kind: 'tool'; name: string }
  /** Tools finished; the model is working through what they returned. */
  | { kind: 'reading' };

/** Turn a tool's snake_case name into something readable. */
function toolLabel(name: string): string {
  return name.replace(/_/g, ' ');
}

/** Show the timer only once a wait is long enough to feel like one. */
const ELAPSED_AFTER_MS = 2500;

function useElapsed(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    // A second is fine — this is a reassurance signal, not a stopwatch.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (startedAt == null) return null;
  const ms = now - startedAt;
  return ms >= ELAPSED_AFTER_MS ? Math.round(ms / 1000) : null;
}

export function ThinkingIndicator({
  phase,
  steps,
  startedAt,
}: {
  phase: AgentPhase;
  /** How many tool calls this turn has made — 0 for a plain answer. */
  steps: number;
  /** When the turn started, for the elapsed readout. */
  startedAt: number | null;
}) {
  const elapsed = useElapsed(startedAt);
  if (phase.kind === 'idle') return null;

  const isTool = phase.kind === 'tool';
  const label =
    phase.kind === 'tool' ? `Running ${toolLabel(phase.name)}`
      : phase.kind === 'reading' ? 'Reading results'
        // Past the first tool call this is no longer a single answer being
        // composed — say so, so a long run reads as deliberate.
        : steps > 0 ? 'Researching' : 'Thinking';

  return (
    <div
      className="flex items-center gap-2 rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-[11px] text-[hsl(var(--muted-foreground))]"
      role="status"
      aria-live="polite"
    >
      {isTool ? (
        <Wrench size={12} className="shrink-0 animate-pulse text-[hsl(var(--primary))]" />
      ) : (
        <Brain size={13} className="shrink-0 animate-pulse text-[hsl(var(--primary))]" />
      )}

      <span className="font-medium text-[hsl(var(--foreground))]">{label}</span>

      {/* Three staggered dots — the "still working" tell that a static label
          can't give you. */}
      <span className="flex items-end gap-0.5 pb-px" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="inline-block h-1 w-1 rounded-full bg-[hsl(var(--muted-foreground))] motion-safe:animate-bounce"
            style={{ animationDelay: `${i * 140}ms`, animationDuration: '1s' }}
          />
        ))}
      </span>

      {steps > 0 && (
        <span className="ml-1 rounded-full bg-[hsl(var(--accent))] px-1.5 py-0.5 text-[9px] uppercase tracking-wider">
          {steps} {steps === 1 ? 'step' : 'steps'}
        </span>
      )}

      {elapsed != null && (
        <span className="ml-auto font-mono text-[10px] tabular-nums opacity-70">{elapsed}s</span>
      )}
    </div>
  );
}
