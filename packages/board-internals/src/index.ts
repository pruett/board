/**
 * The one module that reaches into Board's unexported backend parts.
 *
 * `@vercel/board@0.54.0` builds its local backend from `a2({ store, scheduler, blob })`
 * but does not export it. `patches/@vercel%2Fboard@0.54.0.patch` adds a `./internals`
 * entry; this module types it. When Board exports these, delete the patch and this
 * package, and import from Board directly. Types are copied from Board's source at
 * 0.54.0 (src/store/sql.ts, src/server/blob.ts, src/store/types.ts) and from the
 * experimental-a2 version Board bundles (0.24.0).
 */
import type { Backend } from "@vercel/board"
import type { A2Scheduler, A2Store } from "experimental-a2/server"
// @ts-expect-error: entry added by our patch; it ships no .d.ts
import * as raw from "@vercel/board/internals"

export type { A2Scheduler, A2Store }

/** A SQL query with its parameters, as Board's tables write them. */
export type Sql = { text: string; values: unknown[] }

/** Board's `Db`: what `sqlTables` reads and writes through. */
export type Db = {
  all(query: Sql): Promise<Record<string, unknown>[]>
  /** Each query's rows, all from one snapshot. */
  read(queries: Sql[]): Promise<Record<string, unknown>[][]>
  /** Runs `claim`, then `writes`, in one transaction. False, with nothing written, when `claim` returns no row. */
  commit(claim: Sql, writes: Sql[]): Promise<boolean>
  close(): Promise<void>
}

/** Board's attachment store. */
export type BlobStore = {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<{ data: ReadableStream<Uint8Array> | Uint8Array; contentType: string } | null>
  uploadUrl?(key: string, options: { contentType: string; maxBytes: number; expiresAt: Date }): Promise<{ url: string; headers: Record<string, string> }>
  head?(key: string): Promise<{ size: number } | null>
}

/** Board's message tables, built from the log. Opaque here: only `sqlTables` makes one. */
export type MessageTables = { close(): Promise<void> } & Record<string, unknown>

/** Where a board keeps its log and tables. */
export type BoardStore = { readonly log: A2Store; readonly tables: MessageTables; close(): Promise<void> }

export type A2Options = { store: BoardStore; scheduler?: A2Scheduler; blob?: BlobStore }

export const a2: (options: A2Options) => Backend = raw.a2
export const sqlTables: (db: Db) => MessageTables = raw.sqlTables
/** Board's table DDL, statement by statement. */
export const ddl: () => string[] = raw.ddl
/** a2's SQLite log store, on `node:sqlite` at `path`. */
export const a2SqliteStore: (options: { path: string }) => A2Store & { close(): void } = raw.a2SqliteStore
/** Board's `Db` on `node:sqlite` at `path`. */
export const sqliteDb: (path: string) => Db = raw.sqliteDb
export const localScheduler: () => A2Scheduler & { stop(): void } = raw.localScheduler
export const fsBlob: (dir: string) => BlobStore = raw.fsBlob
export const memoryBlob: () => BlobStore = raw.memoryBlob
