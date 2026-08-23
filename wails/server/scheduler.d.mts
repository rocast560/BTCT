// Type surface of scheduler.mjs for the TypeScript side (tests + tsc).

export interface JobStatus {
  name: string;
  running: boolean;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastTrigger: string | null;
  nextRunAt: number | null;
  runs: number;
}

export interface JobOptions {
  name: string;
  intervalMs: () => number;
  enabled: () => boolean;
  run: (ctx: { trigger: string }) => Promise<void> | void;
  initialLastRunAt?: number | null;
  onStatus?: ((status: JobStatus) => void) | null;
  log?: ((line: string) => void) | null;
}

export interface Job {
  start(): void;
  stop(): void;
  reschedule(): void;
  trigger(reason?: string): Promise<{ ran: true } | { ran: false; reason: string }>;
  status(): JobStatus;
}

export function computeNextRun(lastRunAt: number | null, intervalMs: number, now?: number): number;
export function pauseAllJobs(untilMs: number): void;
export function jobsPausedUntil(): number;
export function createJob(opts: JobOptions): Job;
