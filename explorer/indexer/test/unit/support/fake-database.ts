/**
 * A fake of the database handle that Ponder gives to an indexing function (`context.db`). It keeps rows in memory,
 * keyed by the primary key of each table, and it follows the rules of the real handle that the code under test uses:
 * `find` answers null for a missing row, a plain `insert` of an existing key fails, and the conflict clauses update or
 * keep the stored row. The `sql` handle answers each query from a queue that the test fills, because the fake does not
 * run SQL. The integration tests check the SQL against a real database.
 */
import {
  bridgedSupply,
  bridgeStates,
  chainTips,
  deliveryCosts,
  escrow,
  gateEvents,
  gateStates,
  headUpdates,
  lightClientHeads,
  messages,
  registryObservations,
  releaseEvents,
  tokens,
  transfers,
} from "../../../ponder.schema";

type Row = Record<string, unknown>;

/** The primary key columns of each table, as `ponder.schema.ts` declares them. */
const KEY_COLUMNS = new Map<object, readonly string[]>([
  [messages, ["messageId"]],
  [transfers, ["messageId"]],
  [tokens, ["chainId", "address"]],
  [escrow, ["chainId", "token"]],
  [bridgedSupply, ["chainId", "token"]],
  [releaseEvents, ["id"]],
  [headUpdates, ["chainId", "slot"]],
  [lightClientHeads, ["chainId"]],
  [chainTips, ["chainId"]],
  [deliveryCosts, ["messageId"]],
  [gateEvents, ["id"]],
  [gateStates, ["chainId"]],
  [registryObservations, ["chainId", "version"]],
  [bridgeStates, ["chainId"]],
]);

const keyOf = (table: object, row: Row): string => {
  const columns = KEY_COLUMNS.get(table);
  if (columns === undefined) throw new Error("the fake database does not know this table");
  return columns.map((column) => `${typeof row[column]}:${String(row[column])}`).join("|");
};

/** One write that the code under test made. */
export type Write = {
  readonly table: object;
  readonly action: "insert" | "update" | "keep";
  readonly row: Row;
};

/** One query that went through the `sql` handle. */
export type SqlQuery = { readonly selection: unknown; readonly table: unknown };

/** The fake handle and its controls. */
export type FakeDatabase = ReturnType<typeof createFakeDatabase>;

/** Makes an empty fake database. */
export const createFakeDatabase = () => {
  const tables = new Map<object, Map<string, Row>>();
  const writes: Write[] = [];
  const sqlQueue: unknown[][] = [];
  const sqlQueries: SqlQuery[] = [];

  const tableOf = (table: object): Map<string, Row> => {
    const existing = tables.get(table);
    if (existing !== undefined) return existing;
    const created = new Map<string, Row>();
    tables.set(table, created);
    return created;
  };

  const store = (table: object, row: Row, onConflict: "fail" | "update" | "keep", update: Row): void => {
    const key = keyOf(table, row);
    const rows = tableOf(table);
    const existing = rows.get(key);
    if (existing === undefined) {
      rows.set(key, { ...row });
      writes.push({ table, action: "insert", row: { ...row } });
      return;
    }
    if (onConflict === "fail") throw new Error(`duplicate key ${key}`);
    if (onConflict === "keep") {
      writes.push({ table, action: "keep", row: { ...existing } });
      return;
    }
    rows.set(key, { ...existing, ...update });
    writes.push({ table, action: "update", row: { ...update } });
  };

  const insert = (table: object) => ({
    values: (row: Row) => ({
      then: (resolve: (value: undefined) => unknown, reject: (reason: unknown) => unknown) => {
        try {
          store(table, row, "fail", {});
        } catch (error) {
          return reject(error);
        }
        return resolve(undefined);
      },
      onConflictDoUpdate: async (update: Row): Promise<void> => store(table, row, "update", update),
      onConflictDoNothing: async (): Promise<void> => store(table, row, "keep", {}),
    }),
  });

  const sql = {
    select: (selection: unknown) => ({
      from: (table: unknown) => ({
        where: async () => {
          sqlQueries.push({ selection, table });
          const answer = sqlQueue.shift();
          if (answer === undefined) throw new Error("the test queued no answer for this sql query");
          return answer;
        },
      }),
    }),
  };

  return {
    /** The handle that goes into `context.db`. */
    handle: {
      find: async (table: object, key: Row): Promise<Row | null> => tableOf(table).get(keyOf(table, key)) ?? null,
      insert,
      sql,
    },
    /** Puts a row in a table, as an earlier handler would have. */
    seed: (table: object, row: Row): void => {
      tableOf(table).set(keyOf(table, row), { ...row });
    },
    /** The rows of a table, in insertion order. */
    rows: (table: object): Row[] => [...tableOf(table).values()],
    /** The row with a key, or undefined. */
    row: (table: object, key: Row): Row | undefined => tableOf(table).get(keyOf(table, key)),
    /** Queues the answer of the next `sql` query. */
    queueSqlRows: (rows: unknown[]): void => {
      sqlQueue.push(rows);
    },
    writes,
    sqlQueries,
  };
};
