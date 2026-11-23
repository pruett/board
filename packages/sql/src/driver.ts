/** A row as SQLite returns it: blobs as Uint8Array, integers as numbers. */
export type Row = Record<string, unknown>

/**
 * The SQL port: one synchronous SQLite connection. Both of Board's SQL users run on it:
 * a2's event log (through `node-sqlite.ts`) and Board's tables (through `boardDb`).
 * Adapters: `@board/sql-do` (a Durable Object's SQLite), `@board/sql-node` (a file or `:memory:`).
 */
export interface SqlDriver {
  /** Runs one or more statements with no parameters: DDL. */
  exec(text: string): void
  all(text: string, values: readonly unknown[]): Row[]
  /** Runs a write; `changes` is SQLite's `changes()` for it. */
  run(text: string, values: readonly unknown[]): { changes: number }
  /** Runs `fn` in one transaction: all of its writes land, or, if it throws, none do. Never nests. */
  transaction<T>(fn: () => T): T
  close(): void
}

/** SQLite has no booleans; undefined binds as null. */
export const bind = (value: unknown): unknown =>
  typeof value === "boolean" ? (value ? 1 : 0) : value === undefined ? null : value
