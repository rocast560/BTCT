// ─────────────────────────────────────────────────────────────────────────
// Tiny in-process job scheduler for long-running background work (backups).
//
// Why not setInterval: it drifts (callback time + timer jitter accumulate),
// and it happily starts a second run while the first is still going. Each
// job here is a single armed timeout computed from the LAST run, so runs can
// never overlap (a trigger during a run is reported, not queued) and an
// interval change takes effect on the next tick. `initialLastRunAt` lets the
// caller persist the last run across restarts so an overdue job fires right
// after boot instead of waiting a full interval.
//
// Pure Node; no Bun-only imports, so it is unit-tested under vitest.
// ─────────────────────────────────────────────────────────────────────────

const MAX_TIMEOUT = 2 ** 31 - 1; // setTimeout caps at ~24.8 days

/** Next run time: one interval after the last run, but never in the past. */
export function computeNextRun(lastRunAt, intervalMs, now = Date.now()) {
  if (!lastRunAt) return now + intervalMs;
  return Math.max(now, lastRunAt + intervalMs);
}

// A global pause every job honours (set by a target that was told to back
// off, e.g. a 429 with Retry-After). Stored as an absolute timestamp.
let pausedUntil = 0;
export function pauseAllJobs(untilMs) { pausedUntil = Math.max(pausedUntil, untilMs); }
export function jobsPausedUntil() { return pausedUntil > Date.now() ? pausedUntil : 0; }

/**
 * createJob({ name, intervalMs, enabled, run, initialLastRunAt?, onStatus?, log? })
 *   intervalMs / enabled: functions, read fresh before every schedule so a
 *   config change needs only `reschedule()`.
 *   run: async () => void; a throw is recorded as lastError.
 *   onStatus: called after every run with the status object (persist it).
 */
export function createJob({ name, intervalMs, enabled, run, initialLastRunAt = null, onStatus = null, log = null }) {
  const state = {
    name,
    running: false,
    lastRunAt: initialLastRunAt || null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastError: null,
    lastTrigger: null,
    nextRunAt: null,
    runs: 0,
  };
  let timer = null;
  let started = false;

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  async function runOnce(trigger) {
    if (state.running) return { ran: false, reason: 'already-running' };
    state.running = true;
    state.lastTrigger = trigger;
    const startedAt = Date.now();
    state.lastRunAt = startedAt;
    try {
      await run({ trigger });
      state.lastError = null;
      state.lastSuccessAt = Date.now();
    } catch (e) {
      state.lastError = String(e?.message || e);
      if (log) log(`[${name}] run failed: ${state.lastError}`);
    } finally {
      state.lastDurationMs = Date.now() - startedAt;
      state.runs += 1;
      state.running = false;
    }
    if (onStatus) { try { onStatus(status()); } catch { /* persistence is best-effort */ } }
    if (started) schedule();
    return { ran: true };
  }

  function schedule() {
    clearTimer();
    if (!started || !enabled()) { state.nextRunAt = null; return; }
    const now = Date.now();
    let next = computeNextRun(state.lastRunAt, intervalMs(), now);
    const pause = jobsPausedUntil();
    if (pause > next) next = pause;
    state.nextRunAt = next;
    timer = setTimeout(() => {
      timer = null;
      if (!enabled()) { state.nextRunAt = null; return; }
      if (state.running) { schedule(); return; }
      void runOnce('schedule');
    }, Math.min(MAX_TIMEOUT, Math.max(0, next - now)));
    if (typeof timer.unref === 'function') timer.unref();
  }

  function status() {
    return { ...state };
  }

  return {
    start() { started = true; schedule(); },
    stop() { started = false; clearTimer(); state.nextRunAt = null; },
    /** Recompute the next run (after a config change). */
    reschedule() { if (started) schedule(); },
    /** Run now regardless of `enabled`; resolves when the run finishes. */
    trigger(reason = 'manual') { return runOnce(reason); },
    status,
  };
}
