/**
 * A stand-in for `node:sqlite`, for a2's SQLite log store. Hosts alias `node:sqlite` to this
 * module (wrangler `alias`; a Bun plugin in tests) and register a driver under a path first;
 * `new DatabaseSync(path)` then runs on that driver. Our Board patch makes a2's store call
 * `transactionSync(fn)` instead of `begin … commit`, so its transactions are real here too.
 */
import { bind, type Row, type SqlDriver } from "./driver.ts"

const drivers = new Map<string, SqlDriver>()

/** Makes `new DatabaseSync(path)` use `driver`. Returns a function that removes it. */
export function registerDriver(path: string, driver: SqlDriver): () => void {
  drivers.set(path, driver)
  return () => drivers.delete(path)
}

/** Settings a2 sets that a host's SQLite owns: Durable Objects refuse them, and they change nothing we rely on. */
const HOST_OWNED = /^\s*pragma\s+(journal_mode|synchronous|busy_timeout)\b/i
const TRANSACTION = /^\s*(begin|commit|rollback|savepoint|release)\b/i

export class StatementSync {
  constructor(private readonly driver: SqlDriver, private readonly text: string) {}
  run(...values: unknown[]) { return this.driver.run(this.text, values.map(bind)) }
  all(...values: unknown[]): Row[] { return this.driver.all(this.text, values.map(bind)) }
  get(...values: unknown[]): Row | undefined { return this.driver.all(this.text, values.map(bind))[0] }
  *iterate(...values: unknown[]) { yield* this.all(...values) }
}

export class DatabaseSync {
  private readonly driver: SqlDriver
  constructor(path: string) {
    const driver = drivers.get(path)
    if (!driver) throw new Error(`node:sqlite stand-in: no driver registered for ${path}`)
    this.driver = driver
  }
  exec(text: string): void {
    if (HOST_OWNED.test(text)) return
    if (TRANSACTION.test(text)) throw new Error(`node:sqlite stand-in: use transactionSync, not "${text.trim()}"`)
    this.driver.exec(text)
  }
  prepare(text: string) { return new StatementSync(this.driver, text) }
  transactionSync<T>(fn: () => T): T { return this.driver.transaction(fn) }
  close(): void {}
}

export default { DatabaseSync, StatementSync }
