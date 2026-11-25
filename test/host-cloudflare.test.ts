import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { BoardHost, hostLayer, startupError, type HostBindings } from "../hosts/cloudflare/src/host.ts"
import { makeOpsHandler, ObjectReset, opsAuthorized, OpsStorage } from "../hosts/cloudflare/src/ops.ts"

const TOKEN = "t".repeat(40)

function fakeStorage() {
  const state = { restoreTo: null as string | null, forTime: [] as Date[] }
  const storage: OpsStorage["Service"] = {
    getCurrentBookmark: async () => "bm-now",
    getBookmarkForTime: async (at) => { state.forTime.push(new Date(at)); return "bm-at" },
    onNextSessionRestoreBookmark: async (bookmark) => { state.restoreTo = bookmark; return bookmark },
  }
  return { storage, state }
}

async function opsHandler() {
  const { storage, state } = fakeStorage()
  const resets: string[] = []
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Layer.succeed(OpsStorage, storage),
    Layer.succeed(ObjectReset, { reset: (reason) => resets.push(reason) }),
  ))
  const handler = await runtime.runPromise(Effect.scoped(makeOpsHandler))
  const call = (method: string, path: string, body?: string) =>
    handler(new Request("http://x" + path, { method, ...(body === undefined ? {} : { body }) }))
  return { call, state, resets }
}

describe("/_ops/ routes", () => {
  test("GET bookmark", async () => {
    const { call } = await opsHandler()
    const res = await call("GET", "/_ops/bookmark")
    expect(res.status).toBe(200)
    const body = await res.json() as { bookmark: string; at: string }
    expect(body.bookmark).toBe("bm-now")
    expect(Number.isNaN(Date.parse(body.at))).toBe(false)
  })

  test("POST restore with a bookmark restores and resets after answering", async () => {
    const { call, state, resets } = await opsHandler()
    const res = await call("POST", "/_ops/restore", JSON.stringify({ bookmark: "bm-1" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ restoring: "bm-1" })
    expect(state.restoreTo).toBe("bm-1")
    expect(resets).toEqual([])
    await Bun.sleep(80)
    expect(resets).toEqual(["restoring to bm-1"])
  })

  test("POST restore with a time", async () => {
    const { call, state } = await opsHandler()
    const res = await call("POST", "/_ops/restore", JSON.stringify({ at: "2026-11-20T10:00:00Z" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ restoring: "bm-at", at: "2026-11-20T10:00:00.000Z" })
    expect(state.forTime[0]?.toISOString()).toBe("2026-11-20T10:00:00.000Z")
  })

  test.each([["not json"], ["{}"], [JSON.stringify({ at: "yesterday-ish" })], [JSON.stringify({ bookmark: "" })]])(
    "POST restore %p is a 400",
    async (body) => {
      const { call, state } = await opsHandler()
      const res = await call("POST", "/_ops/restore", body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'send {"bookmark": "<from /_ops/bookmark>"} or {"at": "<ISO time>"}' })
      expect(state.restoreTo).toBeNull()
    },
  )

  test.each([["GET", "/_ops/restore"], ["POST", "/_ops/bookmark"], ["GET", "/_ops/nope"], ["DELETE", "/_ops/x/y"]])(
    "%s %s is a 404",
    async (method, path) => {
      const { call } = await opsHandler()
      const res = await call(method, path)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "no such operation" })
    },
  )
})

describe("opsAuthorized", () => {
  const check = (authorization: string | null, env: object = { BOARD_TOKEN: TOKEN }) =>
    Effect.runPromise(opsAuthorized(new Request("http://x/_ops/bookmark",
      authorization === null ? {} : { headers: { authorization } })).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))))

  test("only the bearer token", async () => {
    expect(await check(`Bearer ${TOKEN}`)).toBe(true)
    expect(await check(null)).toBe(false)
    expect(await check(`Bearer ${"x".repeat(40)}`)).toBe(false)
    expect(await check(`Bearer ${TOKEN}x`)).toBe(false)
  })
})

describe("hostLayer config errors", () => {
  /** Storage that fails on any use: config is read before storage is touched. */
  const unusable = new Proxy({}, { get: () => () => { throw new Error("storage touched") } }) as HostBindings["storage"]

  const start = async (env: Record<string, string>) => {
    const runtime = ManagedRuntime.make(hostLayer({
      objectId: "test", storage: unusable, files: unusable as never, env, reset: () => {},
    }))
    const exit = await runtime.runPromiseExit(BoardHost.use(() => Effect.void))
    await runtime.dispose()
    if (Exit.isSuccess(exit)) throw new Error("expected a failure")
    return startupError(exit.cause)
  }

  test("a missing token names BOARD_TOKEN", async () => {
    const message = await start({ BOARD_OWNER_ID: "token:user:kevin", BOARD_OWNER_HANDLE: "kevin" })
    expect(message).toContain("BOARD_TOKEN")
  })

  test("a short token names the variable, never the value", async () => {
    const secret = "sekrit-value"
    const message = await start({ BOARD_TOKEN: secret, BOARD_OWNER_ID: "token:user:kevin", BOARD_OWNER_HANDLE: "kevin" })
    expect(message).toContain("BOARD_TOKEN")
    expect(message).not.toContain(secret)
  })

  test("a bad owner id names BOARD_OWNER_ID", async () => {
    const message = await start({ BOARD_TOKEN: TOKEN, BOARD_OWNER_ID: "board:x:y", BOARD_OWNER_HANDLE: "kevin" })
    expect(message).toContain("BOARD_OWNER_ID")
    expect(message).not.toContain(TOKEN)
  })
})
