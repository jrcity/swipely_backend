import { vi } from "vitest";

/**
 * A lightweight in-memory Knex-style mock for unit tests.
 *
 * The query builder returned for each table is:
 *  - chainable (every builder method returns the builder), and
 *  - awaitable (a `then` resolves to the pending result),
 * which mirrors how a real Knex builder behaves and supports both
 * `await db(t).where(...).select(...)` and `db(t).insert(...).returning(...)`.
 *
 * Builders are cached per table so per-test overrides such as
 * `db("table").first.mockResolvedValueOnce(...)` apply to the same builder the
 * code under test receives. Transactions reuse the same cached builders.
 *
 * Seed data via `db.__store[table].push(...rows)` and assert via the method
 * mocks, e.g. `db("table").update.mock.calls`.
 */
export type MockDb = ((table: string) => any) & {
  raw: ReturnType<typeof vi.fn>;
  fn: { now: () => Date };
  client: { wrapIdentifier: (id: string) => string };
  transaction: ReturnType<typeof vi.fn>;
  __store: Record<string, any[]>;
};

export function createMockDb(tables: string[]): MockDb {
  const store: Record<string, any[]> = {};
  for (const t of tables) store[t] = [];

  const createQuery = (table: string) => {
    const UNSET = Symbol("unset");
    const rowsOf = () => store[table] ?? (store[table] = []);
    const filters: Array<(row: any) => boolean> = [];
    let limitN: number | null = null;
    let countAlias: string | null = null;
    let result: any = UNSET;

    const applyFilters = (arr: any[]) => arr.filter((r) => filters.every((f) => f(r)));
    const resolveRows = () => {
      let out = result === UNSET ? applyFilters(rowsOf()) : result;
      if (Array.isArray(out) && limitN != null) out = out.slice(0, limitN);
      return out;
    };
    const resolveValue = () => {
      if (countAlias != null) {
        return [{ [countAlias]: String(applyFilters(rowsOf()).length) }];
      }
      return resolveRows();
    };

    const query: any = {
      where: vi.fn((cond: any, op?: any, val?: any) => {
        if (typeof cond === "function") {
          // Nested where callback — best-effort: invoke against the builder.
          cond.call(query, query);
        } else if (typeof cond === "string") {
          if (val === undefined) filters.push((r) => r[cond] === op);
          // 3-arg operator form (e.g. where("x", ">", y)) is not filtered.
        } else if (cond && typeof cond === "object") {
          filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
        }
        return query;
      }),
      whereIn: vi.fn((col: string, arr: any[]) => {
        filters.push((r) => arr.includes(r[col]));
        return query;
      }),
      whereNot: vi.fn(() => query),
      whereNotNull: vi.fn((col: string) => {
        filters.push((r) => r[col] != null);
        return query;
      }),
      whereNull: vi.fn((col: string) => {
        filters.push((r) => r[col] == null);
        return query;
      }),
      whereBetween: vi.fn(() => query),
      orWhere: vi.fn((cb: any) => {
        if (typeof cb === "function") cb.call(query, query);
        return query;
      }),
      andWhere: vi.fn((cond: any) => query.where(cond)),
      orderBy: vi.fn(() => query),
      groupBy: vi.fn(() => query),
      limit: vi.fn((n: number) => {
        limitN = n;
        return query;
      }),
      offset: vi.fn(() => query),
      select: vi.fn(() => {
        result = applyFilters(rowsOf());
        return query;
      }),
      count: vi.fn((expr?: string) => {
        const m = typeof expr === "string" ? expr.match(/as\s+(\w+)/i) : null;
        countAlias = m ? m[1] : "count";
        return query;
      }),
      first: vi.fn(async () => {
        const rows = resolveValue();
        return Array.isArray(rows) ? (rows[0] ?? null) : rows;
      }),
      insert: vi.fn((data: any) => {
        const items = Array.isArray(data) ? data : [data];
        rowsOf().push(...items);
        result = items;
        return query;
      }),
      update: vi.fn((data: any) => {
        const items = applyFilters(rowsOf());
        for (const it of items) Object.assign(it, data);
        result = items;
        return query;
      }),
      delete: vi.fn(() => {
        const keep = rowsOf().filter((r) => !filters.every((f) => f(r)));
        const removed = rowsOf().length - keep.length;
        store[table] = keep;
        result = removed;
        return query;
      }),
      del: vi.fn(() => query.delete()),
      onConflict: vi.fn(() => query),
      merge: vi.fn(() => {
        result = undefined;
        return query;
      }),
      returning: vi.fn(() => query),
      then: (resolve: any, reject: any) =>
        Promise.resolve(resolveValue()).then(resolve, reject),
    };
    return query;
  };

  const queryCache: Record<string, any> = {};
  const db = ((table: string) => (queryCache[table] ??= createQuery(table))) as MockDb;
  db.raw = vi.fn();
  db.fn = { now: () => new Date() };
  db.client = { wrapIdentifier: (id: string) => `"${id}"` };
  db.transaction = vi.fn(async (callback: any) => {
    const trx: any = (table: string) => db(table);
    trx.raw = db.raw;
    trx.fn = db.fn;
    trx.commit = vi.fn();
    trx.rollback = vi.fn();
    return callback(trx);
  });
  db.__store = store;
  return db;
}
