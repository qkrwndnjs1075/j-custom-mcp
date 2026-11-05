import type { WatchStore } from "./watch-store";
import type { Observation, WatchCriteria, WatchSpec } from "./watch-types";

type RunnerOptions = {
  readonly store: WatchStore;
  readonly evaluate: (criteria: WatchCriteria, mode: WatchSpec["mode"]) => Promise<Observation>;
};

export class WatchRunner {
  private pending: Promise<void> | undefined;
  constructor(private readonly options: RunnerOptions) {}

  whenIdle(): Promise<void> {
    return this.pending ?? Promise.resolve();
  }

  async tick(): Promise<{ readonly checked: number; readonly skippedOverlap: boolean }> {
    if (this.pending) return { checked: 0, skippedOverlap: true };
    const completion = Promise.withResolvers<void>();
    this.pending = completion.promise;
    try {
      const observations = new Map<string, Observation>();
      const due = this.options.store.due();
      for (const watch of due) {
        const key = JSON.stringify([watch.criteria, watch.mode]);
        let observation = observations.get(key);
        if (!observation) {
          try {
            observation = await this.options.evaluate(watch.criteria, watch.mode);
          } catch (error) {
            observation = {
              kind: "unknown",
              reason: error instanceof Error ? error.message : "Availability evaluation failed",
            };
          }
          observations.set(key, observation);
        }
        this.options.store.record(watch.id, observation);
      }
      return { checked: due.length, skippedOverlap: false };
    } finally {
      this.pending = undefined;
      completion.resolve();
    }
  }
}
