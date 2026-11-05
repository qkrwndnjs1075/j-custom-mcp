import { decodeCancellation, openCancellationDatabase } from "./cancellation-database";
import {
  CancellationBindingSchema,
  CancellationError,
  type CancellationLimits,
  type CancellationPatch,
  type CancellationQuoteRecord,
  CancellationQuoteRecordSchema,
  type CancellationRecord,
  CancellationRecordSchema,
  type CancellationSpec,
  CancellationSpecSchema,
  type CancellationStage,
  type CancellationStoreOptions,
  cancellationTransitions,
  publicCancellation,
} from "./cancellation-types";
import { type GoCancellationQuote, GoCancellationQuoteSchema } from "./go-ticket-types";
import { DEFAULT_SERVICE_LIMITS } from "./service-limits";
import type { SyncDatabase } from "./sql-database";

export class CancellationStore {
  readonly #db: SyncDatabase;
  readonly #now: () => number;
  readonly #limits: CancellationLimits;
  constructor(
    path: string | SyncDatabase,
    accountId: string,
    options: CancellationStoreOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#limits = options.limits ?? DEFAULT_SERVICE_LIMITS;
    this.#db = openCancellationDatabase(path, accountId);
    try {
      this.recover();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  saveQuote(bindingHash: string, input: GoCancellationQuote): CancellationQuoteRecord {
    const quote = GoCancellationQuoteSchema.safeParse(input);
    if (!quote.success || !CancellationBindingSchema.safeParse(bindingHash).success)
      throw new CancellationError("invalid_spec");
    const now = this.#now();
    const expiresAt = quote.data.quotedAt + this.#limits.cancellationQuoteTtlSeconds * 1000;
    if (quote.data.quotedAt > now || expiresAt <= now) throw new CancellationError("expired");
    return this.#db
      .transaction(() => {
        this.#db.query("DELETE FROM cancellation_quotes WHERE expires_at<=?").run(now);
        const count =
          this.#db
            .query<{ readonly count: number }, []>(
              "SELECT COUNT(*) AS count FROM cancellation_quotes",
            )
            .get()?.count ?? 0;
        if (count >= this.#limits.cancellationQuotes) throw new CancellationError("capacity");
        const record: CancellationQuoteRecord = {
          id: crypto.randomUUID(),
          bindingHash,
          createdAt: now,
          expiresAt,
          quote: quote.data,
        };
        this.#db
          .query("INSERT INTO cancellation_quotes VALUES (?,?,?)")
          .run(record.id, expiresAt, JSON.stringify(record));
        return record;
      })
      .immediate();
  }
  getQuote(id: string): CancellationQuoteRecord | null {
    const row = this.#db
      .query<{ readonly record: string }, [string]>(
        "SELECT record FROM cancellation_quotes WHERE id=?",
      )
      .get(id);
    return row ? decodeCancellation(row, CancellationQuoteRecordSchema) : null;
  }
  create(
    input: CancellationSpec,
    bindingHash: string,
  ): { readonly record: CancellationRecord; readonly created: boolean } {
    const spec = CancellationSpecSchema.safeParse(input);
    if (!spec.success || !CancellationBindingSchema.safeParse(bindingHash).success)
      throw new CancellationError("invalid_spec");
    return this.#db
      .transaction(() => {
        const duplicate = this.#db
          .query<{ readonly record: string }, [string]>(
            "SELECT record FROM cancellations WHERE idempotency_key=?",
          )
          .get(spec.data.idempotencyKey);
        if (duplicate) {
          const record = decodeCancellation(duplicate, CancellationRecordSchema);
          if (
            record.bindingHash !== bindingHash ||
            JSON.stringify(record.spec) !== JSON.stringify(spec.data)
          )
            throw new CancellationError("duplicate_key");
          return { record, created: false };
        }
        const stored = this.getQuote(spec.data.quoteRef);
        if (!stored) throw new CancellationError("invalid_reference");
        if (stored.bindingHash !== bindingHash) throw new CancellationError("account_changed");
        const now = this.#now();
        if (stored.expiresAt <= now) throw new CancellationError("expired");
        if (stored.quote.feeKrw !== spec.data.acceptedFeeKrw)
          throw new CancellationError("fee_changed");
        const records = this.records();
        const active = records.filter((record) =>
          ["prepared", "submitting", "uncertain"].includes(record.stage),
        );
        if (
          records.length >= this.#limits.retainedCancellations ||
          active.length >= this.#limits.activeCancellations
        )
          throw new CancellationError("capacity");
        const record: CancellationRecord = {
          id: crypto.randomUUID(),
          spec: spec.data,
          bindingHash,
          quote: stored.quote,
          stage: "prepared",
          revision: 0,
          createdAt: now,
          updatedAt: now,
          nextCheckAt: now,
          lastError: null,
        };
        this.#db
          .query("INSERT INTO cancellations VALUES (?,?,?,?,?)")
          .run(
            record.id,
            record.spec.idempotencyKey,
            record.stage,
            record.revision,
            JSON.stringify(record),
          );
        return { record, created: true };
      })
      .immediate();
  }
  read(id: string): CancellationRecord | undefined {
    const row = this.#db
      .query<{ readonly record: string }, [string]>("SELECT record FROM cancellations WHERE id=?")
      .get(id);
    return row ? decodeCancellation(row, CancellationRecordSchema) : undefined;
  }
  records(): readonly CancellationRecord[] {
    return this.#db
      .query<{ readonly record: string }, []>("SELECT record FROM cancellations ORDER BY rowid")
      .all()
      .map((row) => decodeCancellation(row, CancellationRecordSchema));
  }
  list() {
    return this.records().map(publicCancellation);
  }
  due(): readonly CancellationRecord[] {
    return this.records().filter(
      (record) =>
        ["submitting", "uncertain"].includes(record.stage) && record.nextCheckAt <= this.#now(),
    );
  }
  claim(id: string, revision: number, input: GoCancellationQuote): CancellationRecord | undefined {
    const parsed = GoCancellationQuoteSchema.safeParse(input);
    if (!parsed.success) throw new CancellationError("invalid_reference");
    const quote = parsed.data;
    return this.#db
      .transaction(() => {
        const record = this.read(id);
        if (record?.stage !== "prepared" || record.revision !== revision) return undefined;
        const reference = this.getQuote(record.spec.quoteRef);
        const now = this.#now();
        if (
          !reference ||
          reference.expiresAt <= now ||
          quote.quotedAt > now ||
          quote.quotedAt + this.#limits.cancellationQuoteTtlSeconds * 1000 <= now
        )
          throw new CancellationError("expired");
        if (reference.bindingHash !== record.bindingHash)
          throw new CancellationError("account_changed");
        if (
          quote.targetKey !== record.quote.targetKey ||
          JSON.stringify(quote.ticket) !== JSON.stringify(record.quote.ticket) ||
          quote.orderNumber !== record.quote.orderNumber ||
          quote.publicationDivision !== record.quote.publicationDivision ||
          JSON.stringify(quote.selectedSeats) !== JSON.stringify(record.quote.selectedSeats) ||
          JSON.stringify(quote.selected) !== JSON.stringify(record.quote.selected)
        )
          throw new CancellationError("invalid_reference");
        if (quote.feeKrw !== record.spec.acceptedFeeKrw) throw new CancellationError("fee_changed");
        const busy = this.records().some(
          (other) =>
            other.id !== id &&
            ["submitting", "uncertain"].includes(other.stage) &&
            other.quote.ticket.service === quote.ticket.service &&
            other.quote.ticket.lineNumber === quote.ticket.lineNumber,
        );
        if (busy) throw new CancellationError("target_busy");
        return this.#write(record, {
          ...record,
          quote,
          stage: "submitting",
          revision: revision + 1,
          updatedAt: now,
        });
      })
      .immediate();
  }
  transition(
    record: CancellationRecord,
    stage: CancellationStage,
    patch: CancellationPatch = {},
  ): CancellationRecord | undefined {
    if (!cancellationTransitions[record.stage].includes(stage))
      throw new CancellationError("configuration");
    return this.#write(record, {
      ...record,
      ...patch,
      stage,
      revision: record.revision + 1,
      updatedAt: this.#now(),
    });
  }
  #write(previous: CancellationRecord, input: CancellationRecord): CancellationRecord | undefined {
    const parsed = CancellationRecordSchema.safeParse(input);
    if (!parsed.success) throw new CancellationError("configuration");
    const next = parsed.data;
    const result = this.#db
      .query(
        "UPDATE cancellations SET stage=?,revision=?,record=? WHERE id=? AND stage=? AND revision=?",
      )
      .run(
        next.stage,
        next.revision,
        JSON.stringify(next),
        previous.id,
        previous.stage,
        previous.revision,
      );
    return result.changes === 1 ? next : undefined;
  }
  recover(): void {
    for (const record of this.records()) {
      if (record.stage === "submitting")
        this.transition(record, "uncertain", {
          nextCheckAt: this.#now(),
          lastError: "reconciliation_pending",
        });
    }
  }
  close(): void {
    this.#db.close();
  }
}
