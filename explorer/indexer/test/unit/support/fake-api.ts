/**
 * A fake of the `ponder:api` module. The `db` builds a query as the Drizzle builder does (`select`, `from`, joins,
 * `where`, `groupBy`, `orderBy`, `limit`) and answers it from a function that the test sets. The fake keeps what each
 * call asked for, including the values that reached the `where` clause, so that a test can check that a filter of the
 * request arrives in the query. The fake runs no SQL. The integration tests check the SQL against a real database.
 */

/** What one query asked for. */
export type QueryCall = {
  /** The selected fields, or undefined for a whole row. */
  readonly fields: Record<string, unknown> | undefined;
  /** The table of `from`. */
  table: unknown;
  /** The tables of the joins, in order. */
  readonly joins: unknown[];
  /** The values that reached the `where` clause, in order. */
  whereValues: unknown[];
  limit: number | null;
  offset: number | null;
  grouped: boolean;
  ordered: boolean;
};

type Responder = (call: QueryCall) => unknown[];

let responder: Responder = () => [];

/** The queries of the current test, in order. */
export const calls: QueryCall[] = [];

/** Sets the function that answers the queries, and forgets the earlier queries. */
export const respondWith = (next: Responder): void => {
  responder = next;
  calls.length = 0;
};

/** The clients of the chains by side name. A test sets the ones that it needs. */
export const publicClients: Record<string, unknown> = {};

/**
 * Collects the bound values in a Drizzle condition: the `Param` objects, and the plain values that a `sql` template
 * holds, inside nested SQL chunks and arrays.
 */
const valuesOf = (node: unknown): unknown[] => {
  if (Array.isArray(node)) return node.flatMap(valuesOf);
  if (["string", "number", "bigint", "boolean"].includes(typeof node)) return [node];
  if (typeof node !== "object" || node === null) return [];
  if ("encoder" in node && "value" in node) return [node.value];
  if ("queryChunks" in node) return valuesOf(node.queryChunks);
  return [];
};

const startQuery = (fields: Record<string, unknown> | undefined) => {
  const call: QueryCall = { fields, table: undefined, joins: [], whereValues: [], limit: null, offset: null, grouped: false, ordered: false };
  calls.push(call);
  const builder = {
    from: (table: unknown) => {
      call.table = table;
      return builder;
    },
    innerJoin: (table: unknown) => {
      call.joins.push(table);
      return builder;
    },
    leftJoin: (table: unknown) => {
      call.joins.push(table);
      return builder;
    },
    where: (condition: unknown) => {
      call.whereValues = valuesOf(condition);
      return builder;
    },
    orderBy: () => {
      call.ordered = true;
      return builder;
    },
    groupBy: () => {
      call.grouped = true;
      return builder;
    },
    limit: (count: number) => {
      call.limit = count;
      return builder;
    },
    offset: (count: number) => {
      call.offset = count;
      return builder;
    },
    then: (resolve: (rows: unknown[]) => unknown, reject: (reason: unknown) => unknown) => {
      try {
        return resolve(responder(call));
      } catch (error) {
        return reject(error);
      }
    },
  };
  return builder;
};

/** The read only database of the API. */
export const db = { select: (fields?: Record<string, unknown>) => startQuery(fields) };
