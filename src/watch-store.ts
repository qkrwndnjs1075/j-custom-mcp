import { DEFAULT_SERVICE_LIMITS, type ServiceLimits } from "./service-limits";
import type { SyncDatabase } from "./sql-database";
import {
  type AlertRow,
  decodeCurrentWatch,
  decodeWatch,
  openWatchDatabase,
  type WatchRow,
} from "./watch-database";
import { decodeStoredAlert } from "./watch-history";
import {
  type AlertPage,
  AlertPayloadSchema,
  AlertQuerySchema,
  type Observation,
  type StoredWatch,
  type Watch,
  type WatchAlert,
  WatchError,
  type WatchSpec,
  WatchSpecSchema,
  watchDedupeKey,
} from "./watch-types";

export class WatchStore {
  private readonly db: SyncDatabase;
  constructor(
    path: string | SyncDatabase,
    private readonly now: () => number = Date.now,
    private readonly limits: ServiceLimits = DEFAULT_SERVICE_LIMITS,
  ) {
    this.db = openWatchDatabase(path);
  }

  private expire(now: number): void {
    this.db
      .query("UPDATE watches SET status='expired' WHERE status='active' AND expires_at <= ?")
      .run(now);
  }
  private prune(): void {
    this.db
      .query(`DELETE FROM watches WHERE status != 'active' AND id NOT IN (
      SELECT id FROM watches WHERE status != 'active' ORDER BY created_at DESC, rowid DESC LIMIT ?
    )`)
      .run(this.limits.retainedWatches);
    this.db
      .query("DELETE FROM alerts WHERE id NOT IN (SELECT id FROM alerts ORDER BY id DESC LIMIT ?)")
      .run(this.limits.retainedAlerts);
  }

  create(input: WatchSpec): { readonly watch: Watch; readonly created: boolean } {
    const spec = WatchSpecSchema.parse(input);
    if (
      spec.intervalSeconds < this.limits.minimumPollSeconds ||
      spec.intervalSeconds > this.limits.maximumPollSeconds ||
      (spec.retryPolicy.mode === "exponential_backoff" &&
        spec.retryPolicy.maxIntervalSeconds > this.limits.maximumPollSeconds)
    )
      throw new WatchError(
        "invalid_interval",
        "Polling interval is outside configured service limits",
      );
    return this.db
      .transaction(() => {
        const now = this.now();
        this.expire(now);
        const key = watchDedupeKey(spec);
        const existing = this.db
          .query<WatchRow, [string]>("SELECT * FROM watches WHERE dedupe_key=? AND status='active'")
          .get(key);
        if (existing) return { watch: decodeCurrentWatch(existing), created: false };
        const expires = Date.parse(spec.expiresAt);
        if (expires <= now) throw new WatchError("expired", "Watch expiry must be in the future");
        const active =
          this.db
            .query<{ readonly count: number }, []>(
              "SELECT COUNT(*) AS count FROM watches WHERE status='active'",
            )
            .get()?.count ?? 0;
        if (active >= this.limits.activeWatches)
          throw new WatchError("capacity", "Active watch limit reached");
        const watch: Watch = {
          ...spec,
          id: crypto.randomUUID(),
          status: "active",
          createdAt: new Date(now).toISOString(),
          nextCheckAt: new Date(now).toISOString(),
          lastCheckedAt: null,
          lastOutcome: null,
          consecutiveFailures: 0,
          lastError: null,
        };
        this.db
          .query(`INSERT INTO watches
        (id,dedupe_key,spec,status,created_at,expires_at,next_check_at) VALUES (?,?,?,'active',?,?,?)`)
          .run(watch.id, key, JSON.stringify(spec), now, expires, now);
        this.prune();
        return { watch, created: true };
      })
      .immediate();
  }

  list(): readonly StoredWatch[] {
    this.expire(this.now());
    this.prune();
    return this.db
      .query<WatchRow, []>("SELECT * FROM watches ORDER BY created_at DESC, rowid DESC")
      .all()
      .map(decodeWatch);
  }

  cancel(id: string): boolean {
    this.expire(this.now());
    const result = this.db
      .query("UPDATE watches SET status='cancelled' WHERE id=? AND status='active'")
      .run(id);
    this.prune();
    return result.changes > 0;
  }

  due(): readonly Watch[] {
    const now = this.now();
    this.expire(now);
    return this.db
      .query<WatchRow, [number, number]>(
        "SELECT * FROM watches WHERE status='active' AND next_check_at <= ? ORDER BY next_check_at, rowid LIMIT ?",
      )
      .all(now, this.limits.activeWatches)
      .map(decodeCurrentWatch);
  }

  record(id: string, observation: Observation): boolean {
    return this.db
      .transaction(() => {
        const now = this.now();
        this.expire(now);
        const row = this.db
          .query<WatchRow, [string]>("SELECT * FROM watches WHERE id=? AND status='active'")
          .get(id);
        if (!row) return false;
        const watch = decodeCurrentWatch(row);
        let matched = row.matched;
        let failures = 0;
        let error: string | null = null;
        let emitted = false;
        switch (observation.kind) {
          case "matched": {
            if (observation.matches.length === 0)
              throw new WatchError("invalid_observation", "A match must contain a trip");
            if (!matched || watch.notification === "every_match") {
              const payload = AlertPayloadSchema.parse({
                mode: watch.mode,
                criteria: watch.criteria,
                matches: observation.matches.slice(0, this.limits.alertMatches),
                matchCount: observation.matches.length,
              });
              this.db
                .query("INSERT INTO alerts(watch_id,generated_at,payload) VALUES (?,?,?)")
                .run(id, now, JSON.stringify(payload));
              emitted = true;
            }
            matched = 1;
            break;
          }
          case "not_matched":
            matched = 0;
            break;
          case "inconclusive":
            error = observation.reason.slice(0, 500);
            break;
          case "unknown":
            failures = row.failures + 1;
            error = observation.reason.slice(0, 500);
            break;
          default: {
            const exhaustive: never = observation;
            throw exhaustive;
          }
        }
        const delay =
          watch.retryPolicy.mode === "fixed_interval"
            ? watch.intervalSeconds
            : Math.min(
                watch.retryPolicy.maxIntervalSeconds,
                watch.intervalSeconds * 2 ** Math.min(failures, 53),
              );
        const next = Math.min(row.expires_at, now + delay * 1_000);
        this.db
          .query(
            `UPDATE watches SET matched=?,last_outcome=?,last_checked_at=?,failures=?,last_error=?,next_check_at=? WHERE id=?`,
          )
          .run(matched, observation.kind, now, failures, error, next, id);
        this.prune();
        return emitted;
      })
      .immediate();
  }

  getAlerts(query: { readonly after: number; readonly limit: number }): AlertPage {
    const { after, limit } = AlertQuerySchema.parse(query);
    if (limit > this.limits.alertPageSize)
      throw new WatchError(
        "invalid_pagination",
        "Alert page size exceeds configured service limit",
      );
    const bounds = this.db
      .query<{ readonly oldest: number | null; readonly latest: number | null }, []>(
        "SELECT MIN(id) AS oldest, MAX(id) AS latest FROM alerts",
      )
      .get();
    const oldest = bounds?.oldest ?? null;
    const latest = bounds?.latest ?? 0;
    const alerts: readonly WatchAlert[] = this.db
      .query<AlertRow, [number, number]>("SELECT * FROM alerts WHERE id>? ORDER BY id LIMIT ?")
      .all(after, limit)
      .map((row) => ({
        ...decodeStoredAlert(JSON.parse(row.payload)),
        cursor: row.id,
        watchId: row.watch_id,
        generatedAt: new Date(row.generated_at).toISOString(),
        delivery: "inbox_only",
      }));
    const nextCursor = alerts.at(-1)?.cursor ?? after;
    return {
      alerts,
      oldestCursor: oldest,
      latestCursor: latest,
      nextCursor,
      hasMore: nextCursor < latest,
      gap: oldest !== null && after < oldest - 1,
    };
  }

  close(): void {
    this.db.close();
  }
}
