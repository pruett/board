import { describe, expect, mock, test } from "bun:test"
import { DatabaseSync as StandIn } from "@board/sql/node-sqlite"
import type { ManagedRuntime } from "effect"
import type { BoardHost } from "../hosts/cloudflare/src/host.ts"
import type { Env } from "../hosts/cloudflare/src/index.ts"

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}))

const { BoardObject, default: worker } = await import("../hosts/cloudflare/src/index.ts")
const TOKEN = "checker-token-value-".repeat(3)

function harness(config: Record<string, string> = {}) {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
  const db = new DatabaseSync(":memory:")
  const id = "checker-" + crypto.randomUUID()
  const blocks: Promise<unknown>[] = []
  const aborts: string[] = []
  let alarmAt: number | null = null
  let forwarded = 0
  const state = {
    id: { toString: () => id },
    storage: {
      sql: {
        exec(text: string, ...values: unknown[]) {
          if (values.length || /^\s*(select|with|pragma)\b/i.test(text)) {
            const rows = db.prepare(text).all(...values as never[])
            return { toArray: () => rows }
          }
          db.exec(text)
          return { toArray: () => [] }
        },
      },
      transactionSync: <T>(fn: () => T) => {
        db.exec("begin")
        try { const value = fn(); db.exec("commit"); return value }
        catch (error) { db.exec("rollback"); throw error }
      },
      getAlarm: async () => alarmAt,
      setAlarm: async (at: number) => { alarmAt = at },
      getCurrentBookmark: async () => "bm-now",
      getBookmarkForTime: async () => "bm-at",
      onNextSessionRestoreBookmark: async (bookmark: string) => bookmark,
    },
    blockConcurrencyWhile<T>(fn: () => Promise<T>) { const block = fn(); blocks.push(block); return block },
    abort: (reason: string) => { aborts.push(reason) },
  }
  const env = {
    BOARD_TOKEN: TOKEN,
    BOARD_OWNER_ID: "token:user:checker",
    BOARD_OWNER_HANDLE: "checker",
    FILES: {},
    BOARD: {
      idFromName: () => "board",
      get: () => ({ fetch: async () => { forwarded++; return Response.json({ forwarded: true }) } }),
    },
    ...config,
  } as unknown as Env
  const object = new BoardObject(state as unknown as DurableObjectState, env)
  const runtime: ManagedRuntime.ManagedRuntime<BoardHost, unknown> = Reflect.get(object, "runtime")
  return {
    env, object, aborts, id, forwarded: () => forwarded,
    ready: () => Promise.all(blocks),
    close: async () => { await runtime.dispose(); db.close() },
  }
}

describe("acceptance: actual BoardObject startup and reset", () => {
  test.each([
    ["BOARD_TOKEN", "short-secret"],
    ["BOARD_OWNER_ID", "board:user:checker"],
    ["BOARD_OWNER_HANDLE", "two words"],
  ])("bad %s becomes repeatable JSON 500 after the concurrency block", async (variable, value) => {
    const h = harness({ [variable]: value })
    try {
      await h.ready()
      for (let i = 0; i < 2; i++) {
        const response = await h.object.fetch(new Request("http://x/api/board"))
        const body = await response.text()
        console.log(JSON.stringify({ variable, status: response.status, body, aborts: h.aborts }))
        expect(response.status).toBe(500)
        expect(body).toContain(variable)
        expect(body).not.toContain(TOKEN)
        if (variable === "BOARD_TOKEN") expect(body).not.toContain(value)
      }
      expect(h.aborts).toEqual([])
    } finally { await h.close() }
  })

  test("fetch and alarm work after startup; restore disposes the registered driver before abort", async () => {
    const h = harness()
    try {
      await h.ready()
      const response = await h.object.fetch(new Request("http://x/_ops/bookmark"))
      console.log("startup bookmark:", response.status, await response.clone().text())
      expect(response.status).toBe(200)
      await h.object.alarm()
      expect(() => new StandIn("do:" + h.id)).not.toThrow()
      const restored = await h.object.fetch(new Request("http://x/_ops/restore", {
        method: "POST", body: JSON.stringify({ bookmark: "bm-1" }),
      }))
      expect(await restored.json()).toEqual({ restoring: "bm-1" })
      await Bun.sleep(90)
      expect(h.aborts).toEqual(["restoring to bm-1"])
      expect(() => new StandIn("do:" + h.id)).toThrow("no driver registered")
    } finally { await h.close() }
  })

  test("the Worker returns JSON 401 without or with a wrong token, and forwards the right one", async () => {
    const h = harness()
    try {
      await h.ready()
      for (const authorization of [null, "Bearer wrong", "Bearer " + TOKEN]) {
        const response = await worker.fetch(new Request("http://x/_ops/bookmark", {
          ...(authorization === null ? {} : { headers: { authorization } }),
        }), h.env)
        expect(response.status).toBe(authorization === "Bearer " + TOKEN ? 200 : 401)
        expect(await response.json()).toEqual(authorization === "Bearer " + TOKEN ? { forwarded: true } : { error: "unauthorized" })
      }
      expect(h.forwarded()).toBe(1)
    } finally { await h.close() }
  })
})
