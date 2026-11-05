export type SqlValue = string | number | null;

export interface SyncStatement<Row extends Record<string, SqlValue>, Params extends SqlValue[]> {
  get(...params: Params): Row | null;
  all(...params: Params): Row[];
  run(...params: Params): { readonly changes: number };
}

export interface SyncDatabase {
  query<
    Row extends Record<string, SqlValue> = Record<string, SqlValue>,
    Params extends SqlValue[] = SqlValue[],
  >(sql: string): SyncStatement<Row, Params>;
  exec(sql: string): void;
  run(sql: string): void;
  transaction<T>(fn: () => T): { immediate(): T };
  close(): void;
}
