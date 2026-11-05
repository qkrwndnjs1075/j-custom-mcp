import type { ServiceLimits } from "./service-limits";

type TickResult = { readonly remainingUsers: number };
type SchedulerClock = {
  readonly now: () => number;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function runScheduler(
  options: {
    readonly tick: () => Promise<TickResult>;
    readonly limits: Pick<ServiceLimits, "schedulerIntervalMs" | "minimumPollSeconds">;
    readonly signal: AbortSignal;
  },
  clock: SchedulerClock = { now: () => performance.now(), wait },
): Promise<void> {
  const intervalMs = Math.min(
    options.limits.schedulerIntervalMs,
    options.limits.minimumPollSeconds * 1_000,
  );
  while (!options.signal.aborted) {
    const startedAt = clock.now();
    let remainingUsers: number;
    do {
      ({ remainingUsers } = await options.tick());
    } while (remainingUsers > 0 && !options.signal.aborted);
    if (options.signal.aborted) break;
    await clock.wait(Math.max(0, intervalMs - (clock.now() - startedAt)), options.signal);
  }
}
