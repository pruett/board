import { describe, expect, test } from "bun:test"
import { board } from "@vercel/board"
import { a2, a2SqliteStore, localScheduler, memoryBlob, sqliteDb, sqlTables } from "./index.ts"

describe("@board/internals", () => {
  test("composes a working board from Board's own parts", async () => {
    const store = { log: a2SqliteStore({ path: ":memory:" }), tables: sqlTables(sqliteDb(":memory:")), close: async () => {} }
    const scheduler = localScheduler()
    const team = board({ backend: a2({ store, scheduler, blob: memoryBlob() }) })
    const posted = await team.post("deploys", "www@a1b2c3 is live")
    const { messages } = await team.channel("deploys").messages()
    expect(messages.map((m: { text: string }) => m.text)).toEqual(["www@a1b2c3 is live"])
    expect(posted.id).toBeDefined()
    scheduler.stop()
  })
})
