import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { board } from "@vercel/board"
import { a2, a2SqliteStore, memoryBlob, sqlTables } from "@board/internals"
import { nodeSqlDriver } from "@board/sql-node"
import { boardDb, registerDriver, type SqlDriver } from "@board/sql"
import { DatabaseSync } from "@board/sql/node-sqlite"
import { DoSql, DoStorage, doSqlPath } from "@board/sql-do"
import { Context, Effect, Exit, Layer, Scope } from "effect"

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

/** A board whose log and tables share one SqlDriver, as in the Durable Object. */
function open(driver: SqlDriver, name: string) {
  cleanups.push(registerDriver(name, driver))
  const store = { log: a2SqliteStore({ path: name }), tables: sqlTables(boardDb(driver)), close: async () => {} }
  return board({ backend: a2({ store, blob: memoryBlob() }) })
}

describe("Board on a SqlDriver", () => {
  test("posts, labels and claims through the stand-in", async () => {
    const team = open(nodeSqlDriver(":memory:"), "mem")
    const root = await team.post("flight-sync", "PR #28 ready", { labels: { state: "open" } })
    await team.reply(root.id, "looking")
    const { messages } = await team.channel("flight-sync").messages()
    expect(messages.map((m: { text: string }) => m.text)).toEqual(["PR #28 ready", "looking"])
  })

  test("keeps everything after the process reopens the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "board-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, "board.db")
    const first = nodeSqlDriver(file)
    await open(first, "a").post("flight-sync", "before restart")
    first.close()
    const { messages } = await open(nodeSqlDriver(file), "b").channel("flight-sync").messages()
    expect(messages.map((m: { text: string }) => m.text)).toEqual(["before restart"])
  })
})

describe("boardDb", () => {
  test("a commit that fails halfway writes nothing", async () => {
    const driver = nodeSqlDriver(":memory:")
    const db = boardDb(driver)
    driver.exec("create table t (x integer)")
    const commit = db.commit({ text: "select 1", values: [] }, [
      { text: "insert into t values ($1)", values: [1] },
      { text: "insert into missing values (1)", values: [] },
    ])
    await expect(commit).rejects.toThrow()
    expect(driver.all("select count(*) as n from t", [])).toEqual([{ n: 0 }])
  })

  test("a claim that matches no row writes nothing and answers false", async () => {
    const driver = nodeSqlDriver(":memory:")
    const db = boardDb(driver)
    driver.exec("create table t (x integer)")
    const done = await db.commit({ text: "select 1 where 0", values: [] }, [{ text: "insert into t values (1)", values: [] }])
    expect(done).toBe(false)
    expect(driver.all("select count(*) as n from t", [])).toEqual([{ n: 0 }])
  })
})

test("a2's log store runs on the stand-in, not on a file", async () => {
  const { existsSync } = await import("node:fs")
  open(nodeSqlDriver(":memory:"), "stand-in-check")
  expect(existsSync("stand-in-check")).toBe(false)
})

/** A Durable Object's `ctx.storage`, faked on the real node:sqlite (single statements only). */
function fakeDoStorage(): DoStorage["Service"] {
  const { DatabaseSync: Real } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
  const db = new Real(":memory:")
  const sql = {
    exec: (text: string, ...values: unknown[]) => {
      const rows = db.prepare(text).all(...(values as never[]))
      return { toArray: () => rows }
    },
  }
  return { sql, transactionSync: <T>(fn: () => T) => fn() } as unknown as DoStorage["Service"]
}

describe("DoSql.layerRegistered", () => {
  test("registers the driver under do:<id> and removes it when the scope closes", async () => {
    const layer = DoSql.layerRegistered("obj-1").pipe(Layer.provide(Layer.succeed(DoStorage, fakeDoStorage())))
    const scope = Effect.runSync(Scope.make())
    const ctx = await Effect.runPromise(Layer.buildWithScope(layer, scope))

    const db = new DatabaseSync(doSqlPath("obj-1"))
    db.exec("create table t (x integer)")
    expect(db.prepare("insert into t values (?)").run(7)).toEqual({ changes: 1 })
    expect(Context.get(ctx, DoSql).all("select x from t", [])).toEqual([{ x: 7 }])

    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(() => new DatabaseSync("do:obj-1")).toThrow("no driver registered for do:obj-1")
  })
})
