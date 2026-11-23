import type { Row, SqlDriver } from "@board/sql"

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
export function doSqlDriver(storage: DurableObjectStorage): SqlDriver {
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
