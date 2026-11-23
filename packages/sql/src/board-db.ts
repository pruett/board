import { ddl, type Db, type Sql } from "@board/internals"
import { bind, type SqlDriver } from "./driver.ts"

/** `$1` → `?1`: Board writes Postgres-style parameters; SQLite takes numbered ones. */
const numbered = (text: string) => text.replace(/\$(\d+)/g, "?$1")
const run = (driver: SqlDriver, query: Sql) => driver.all(numbered(query.text), query.values.map(bind))

/**
 * Board's `Db` on any `SqlDriver`. Creates Board's tables on first use. Each `read` sees one
 * snapshot and each `commit` is one transaction: a claim that matches no row, or a write
 * that throws, leaves nothing written.
 */
export function boardDb(driver: SqlDriver): Db {
  for (const statement of ddl()) driver.exec(statement)
  return {
    all: async (query) => run(driver, query),
    read: async (queries) => driver.transaction(() => queries.map((q) => run(driver, q))),
    commit: async (claim, writes) =>
      driver.transaction(() => {
        if (run(driver, claim).length === 0) return false
        for (const write of writes) run(driver, write)
        return true
      }),
    close: async () => driver.close(),
  }
}
