import type { Row, SqlDriver } from "@board/sql"

/** The SQL port on `node:sqlite` (Node 22.5+, Bun 1.4+): a file, or `:memory:`. */
export function nodeSqlDriver(path: string): SqlDriver {
  // Not `import "node:sqlite"`: hosts and tests point that specifier at our stand-in for a2.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
  const db = new DatabaseSync(path)
  if (path !== ":memory:") db.exec("pragma journal_mode = wal")
  let depth = 0
  return {
    exec: (text) => db.exec(text),
    all: (text, values) => db.prepare(text).all(...(values as never[])) as Row[],
    run: (text, values) => ({ changes: Number(db.prepare(text).run(...(values as never[])).changes) }),
    transaction(fn) {
      if (depth > 0) throw new Error("sql-node: transactions do not nest")
      depth++
      db.exec("begin immediate")
      try {
        const result = fn()
        db.exec("commit")
        return result
      } catch (error) {
        db.exec("rollback")
        throw error
      } finally {
        depth--
      }
    },
    close: () => db.close(),
  }
}
