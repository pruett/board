import { registerDriver, type Row, type SqlDriver } from "@board/sql"
import { Context, Effect, Layer } from "effect"

/** The part of a Durable Object's storage (`ctx.storage`) this adapter uses. */
export class DoStorage extends Context.Service<DoStorage, Pick<DurableObjectStorage, "sql" | "transactionSync">>()(
  "board/DoStorage",
) {}

/** Durable Objects return BLOBs as ArrayBuffer; node:sqlite and Board expect Uint8Array. */
const toRow = (row: Record<string, SqlStorageValue>): Row => {
  for (const key in row) if (row[key] instanceof ArrayBuffer) (row as Row)[key] = new Uint8Array(row[key])
  return row as Row
}

/**
 * The SQL port on a Durable Object's SQLite (`ctx.storage`). Transactions use
 * `transactionSync`, which rolls back when its callback throws; `sql.exec` itself refuses
 * BEGIN and SAVEPOINT.
 */
function doSqlDriver(storage: DoStorage["Service"]): SqlDriver {
  const { sql } = storage
  return {
    exec: (text) => void sql.exec(text).toArray(),
    all: (text, values) => sql.exec(text, ...(values as SqlStorageValue[])).toArray().map(toRow),
    run(text, values) {
      sql.exec(text, ...(values as SqlStorageValue[])).toArray()
      // Not cursor.rowsWritten: that also counts index rows. a2 checks `changes === 1`.
      const [row] = sql.exec<{ c: number }>("select changes() as c").toArray()
      return { changes: Number(row?.c ?? 0) }
    },
    transaction: (fn) => storage.transactionSync(fn),
    close() {},
  }
}

/** The SqlDriver on the object's storage. Synchronous, so there is no runtime to capture. */
export const makeDoSqlDriver: Effect.Effect<SqlDriver, never, DoStorage> = Effect.map(DoStorage, doSqlDriver)

/** The object's SqlDriver as a service. */
export class DoSql extends Context.Service<DoSql, SqlDriver>()("board/DoSql") {
  static readonly layer: Layer.Layer<DoSql, never, DoStorage> = Layer.effect(DoSql, makeDoSqlDriver)

  /**
   * Registers the driver with the node:sqlite stand-in under `do:<id>`, so a2's
   * `new DatabaseSync("do:<id>")` runs on it, and unregisters it when the scope closes.
   */
  static readonly layerRegistered = (id: string): Layer.Layer<DoSql, never, DoStorage> =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const driver = yield* DoSql
        yield* Effect.acquireRelease(
          Effect.sync(() => registerDriver(doSqlPath(id), driver)),
          (unregister) => Effect.sync(unregister),
        )
      }),
    ).pipe(Layer.provideMerge(DoSql.layer))
}

/** The stand-in path a2 opens for object `id`. */
export const doSqlPath = (id: string): string => `do:${id}`
