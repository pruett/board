import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { makeOpsHandler, ObjectReset, OpsStorage } from "../hosts/cloudflare/src/ops.ts"

async function withOps(check: (handler: (request: Request) => Promise<Response>, calls: string[]) => Promise<void>) {
  const calls: string[] = []
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Layer.succeed(OpsStorage, {
      getCurrentBookmark: async () => { calls.push("getCurrentBookmark"); return "bm-now" },
      getBookmarkForTime: async () => { calls.push("getBookmarkForTime"); return "bm-at" },
      onNextSessionRestoreBookmark: async (bookmark) => { calls.push("restore:" + bookmark); return bookmark },
    }),
    Layer.succeed(ObjectReset, { reset: () => {} }),
  ))
  try {
    await check(await runtime.runPromise(Effect.scoped(makeOpsHandler)), calls)
  } finally {
    await runtime.dispose()
  }
}

describe("acceptance: exact ops paths, methods, and JSON shapes", () => {
  test.each([
    ["HEAD", "/_ops/bookmark"],
    ["GET", "/_ops/bookmark/"],
    ["POST", "/_ops/restore/"],
    ["GET", "/_ops/BOOKMARK"],
    ["GET", "/_ops/"],
    ["GET", "/_ops//bookmark"],
  ])("%s %s preserves the old 404", async (method, path) => {
    await withOps(async (handler, calls) => {
      const response = await handler(new Request("http://x" + path, {
        method,
        ...(method === "POST" ? { body: JSON.stringify({ bookmark: "bm-1" }) } : {}),
      }))
      console.log(JSON.stringify({ method, path, status: response.status, body: await response.text(), calls }))
      expect(response.status).toBe(404)
      expect(calls).toEqual([])
    })
  })

  test("a body with both fields preserves the at response field and bookmark precedence", async () => {
    await withOps(async (handler, calls) => {
      const response = await handler(new Request("http://x/_ops/restore", {
        method: "POST",
        body: JSON.stringify({ bookmark: "bm-1", at: "2026-11-20T10:00:00Z" }),
      }))
      const body = await response.json()
      console.log(JSON.stringify({ status: response.status, body, calls }))
      expect(response.status).toBe(200)
      expect(body).toEqual({ restoring: "bm-1", at: "2026-11-20T10:00:00.000Z" })
      expect(calls).toEqual(["restore:bm-1"])
    })
  })
})
