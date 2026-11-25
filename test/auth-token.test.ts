import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Redacted, Result } from "effect"
import { board, HttpError } from "@vercel/board"
import { a2, a2SqliteStore, memoryBlob, sqlTables } from "@board/internals"
import { nodeSqlDriver } from "@board/sql-node"
import { boardDb, registerDriver } from "@board/sql"
import { agentScope, DEFAULT_AGENT_CAN, makeTokenAuth, sha256Hex, TokenAuthConfig, type TokenRequest } from "@board/auth-token"

const TOKEN = "t".repeat(32)
const valid = { BOARD_TOKEN: TOKEN, BOARD_OWNER_ID: "token:user:kevin", BOARD_OWNER_HANDLE: "kevin" }

const withEnv = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))

/** A request as Board hands it over: the credential, and claims with no `x-board-can`. */
const req = (credential: string, scope: string | null = null): TokenRequest => ({ credential, claims: { scope } })

/** The HttpError status `authenticate` rejects with. */
const status = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => e instanceof HttpError ? e.status : e)

/** The ConfigError message for `env`, or "ok". */
const configError = (env: Record<string, string>) =>
  Effect.runPromise(TokenAuthConfig.pipe(
    Effect.as("ok"),
    Effect.catchTag("ConfigError", (e) => Effect.succeed(e.message)),
    withEnv(env),
  ))

describe("TokenAuthConfig", () => {
  test("accepts a valid set, with the token redacted", async () => {
    const config = await Effect.runPromise(TokenAuthConfig.pipe(withEnv(valid)))
    expect(Redacted.isRedacted(config.token)).toBe(true)
    expect(Redacted.value(config.token)).toBe(TOKEN)
    expect(String(config.token)).not.toContain(TOKEN)
    expect(config.owner).toEqual({ id: "token:user:kevin", handle: "kevin" })
  })

  test("rejects a short token, naming the variable but not the value", async () => {
    const message = await configError({ ...valid, BOARD_TOKEN: "short-secret" })
    expect(message).toContain("BOARD_TOKEN")
    expect(message).toContain("at least 32")
    expect(message).not.toContain("short-secret")
  })

  test("rejects a board: owner id", async () => {
    const message = await configError({ ...valid, BOARD_OWNER_ID: "board:user:kevin" })
    expect(message).toContain("BOARD_OWNER_ID")
    expect(message).toContain(`must not start with "board:"`)
  })

  test("rejects a malformed owner id", async () => {
    expect(await configError({ ...valid, BOARD_OWNER_ID: "kevin" })).toContain("BOARD_OWNER_ID")
  })

  test("rejects a handle with a space", async () => {
    const message = await configError({ ...valid, BOARD_OWNER_HANDLE: "kevin pruett" })
    expect(message).toContain("BOARD_OWNER_HANDLE")
  })

  test("rejects a missing variable", async () => {
    const { BOARD_TOKEN: _, ...rest } = valid
    expect(await configError(rest)).toContain("BOARD_TOKEN")
  })
})

describe("makeTokenAuth", () => {
  const authenticate = Effect.runSync(makeTokenAuth.pipe(withEnv(valid)))

  test("no credential is not ours", async () => {
    expect(await authenticate({})).toBeNull()
    expect(await authenticate({ credential: null })).toBeNull()
  })

  test("the right token is the owner", async () => {
    expect(await authenticate({ credential: TOKEN })).toEqual({ id: "token:user:kevin", kind: "person", handle: "kevin" })
  })

  test("a wrong token is a 401 HttpError", async () => {
    const error = await authenticate({ credential: "x".repeat(32) }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(401)
  })
})

describe("BOARD_TOKENS", () => {
  const A = "a".repeat(40), B = "b".repeat(40)
  const agentsEnv = async () => ({
    ...valid,
    BOARD_TOKENS: JSON.stringify({
      [await sha256Hex(A)]: { id: "token:agent:implementer-1", handle: "implementer-1" },
      [await sha256Hex(B)]: { id: "token:agent:implementer-2", handle: "implementer-2" },
    }),
  })

  test("each agent token is its own principal; the person token is still the person", async () => {
    const authenticate = Effect.runSync(makeTokenAuth.pipe(withEnv(await agentsEnv())))
    expect(await authenticate(req(A))).toEqual({ id: "token:agent:implementer-1", kind: "person", handle: "implementer-1" })
    expect(await authenticate(req(B))).toEqual({ id: "token:agent:implementer-2", kind: "person", handle: "implementer-2" })
    expect(await authenticate(req(TOKEN))).toEqual({ id: "token:user:kevin", kind: "person", handle: "kevin" })
    expect(await authenticate({})).toBeNull()
  })

  test("an unknown token is a 401, and a removed entry's token too", async () => {
    const env = await agentsEnv()
    const onlyA = { ...env, BOARD_TOKENS: JSON.stringify({ [await sha256Hex(A)]: { id: "token:agent:implementer-1", handle: "implementer-1" } }) }
    const authenticate = Effect.runSync(makeTokenAuth.pipe(withEnv(onlyA)))
    for (const credential of ["x".repeat(32), B]) {
      expect(await status(authenticate(req(credential)))).toBe(401)
    }
  })

  test("not JSON is a ConfigError naming BOARD_TOKENS without the text", async () => {
    const message = await configError({ ...valid, BOARD_TOKENS: `{${A}` })
    expect(message).toContain("BOARD_TOKENS")
    expect(message).not.toContain(A)
  })

  test("a raw token where its hash belongs is refused without echoing it", async () => {
    const message = await configError({ ...valid, BOARD_TOKENS: JSON.stringify({ [A]: { id: "token:agent:x", handle: "x" } }) })
    expect(message).toContain("BOARD_TOKENS entry 1")
    expect(message).not.toContain(A)
  })

  test("a bad owner, an array, or a duplicate id is refused", async () => {
    const hash = await sha256Hex(A)
    expect(await configError({ ...valid, BOARD_TOKENS: JSON.stringify({ [hash]: { id: "agent-1", handle: "a" } }) })).toContain("BOARD_TOKENS entry 1")
    expect(await configError({ ...valid, BOARD_TOKENS: "[]" })).toContain("BOARD_TOKENS")
    expect(await configError({ ...valid, BOARD_TOKENS: JSON.stringify({ [hash]: { id: "token:user:kevin", handle: "k2" } }) })).toContain("already taken")
  })

  test("absent is no agents", async () => {
    const config = await Effect.runPromise(TokenAuthConfig.pipe(withEnv(valid)))
    expect(config.agents.size).toBe(0)
  })
})

describe("agent scope", () => {
  const A = "a".repeat(40), B = "b".repeat(40)
  const entry = async (token: string, value: object) => ({ [await sha256Hex(token)]: value })
  const env = async (...entries: Array<Record<string, object>>) => ({ ...valid, BOARD_TOKENS: JSON.stringify(Object.assign({}, ...entries)) })
  const agentA = { id: "token:agent:implementer-1", handle: "implementer-1" }
  const agentB = { id: "token:agent:implementer-2", handle: "implementer-2" }

  test("an entry without can gets read, post, react and label everywhere, never manage or sync", async () => {
    expect(DEFAULT_AGENT_CAN).toEqual({ "*": ["read", "post", "react", "label"] })
    const authenticate = Effect.runSync(makeTokenAuth.pipe(withEnv(await env(await entry(A, agentA)))))
    const request = req(A)
    await authenticate(request)
    expect(request.claims?.scope).toBe("*=read,post,react,label")
  })

  test("an entry's can is its scope, as x-board-can text", async () => {
    const can = { "fleet2/": ["read", "post", "react", "label", "manage"], "hq": ["read"] }
    const authenticate = Effect.runSync(makeTokenAuth.pipe(withEnv(await env(await entry(A, { ...agentA, can }), await entry(B, agentB)))))
    const a = req(A), b = req(B)
    await authenticate(a)
    await authenticate(b)
    expect(a.claims?.scope).toBe("fleet2/=read,post,react,label,manage;hq=read")
    expect(b.claims?.scope).toBe("*=read,post,react,label")
  })

  test("can \"all\" is allowed when an entry asks for it", async () => {
    const authenticate = Effect.runSync(makeTokenAuth.pipe(withEnv(await env(await entry(A, { ...agentA, can: { "*": "all" } })))))
    const request = req(A)
    await authenticate(request)
    expect(request.claims?.scope).toBe("*=all")
  })

  test("the person stays unscoped, and keeps a scope it sends itself", async () => {
    const authenticate = Effect.runSync(makeTokenAuth.pipe(withEnv(await env(await entry(A, agentA)))))
    const bare = req(TOKEN), narrowed = req(TOKEN, "dev/=read")
    await authenticate(bare)
    await authenticate(narrowed)
    expect(bare.claims?.scope).toBeNull()
    expect(narrowed.claims?.scope).toBe("dev/=read")
  })

  test("an agent that sends its own x-board-can is a 403 saying why, and so is one with no claims", async () => {
    const authenticate = Effect.runSync(makeTokenAuth.pipe(withEnv(await env(await entry(A, agentA)))))
    const error = await authenticate(req(A, "*=all")).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(403)
    expect((error as HttpError).message).toContain("can't widen or narrow its own scope")
    expect(await status(authenticate(req(A, "*=read")))).toBe(403)
    expect(await status(authenticate({ credential: A }))).toBe(403)
  })

  test("a bad can is a ConfigError naming the entry", async () => {
    for (const can of [{ "*": ["read", "admin"] }, {}, { "*": "everything" }, ["read"]]) {
      const message = await configError(await env(await entry(A, { ...agentA, can })))
      expect(message).toContain("BOARD_TOKENS entry 1")
    }
  })

  // Review #498 finding 1: checked only after canText joined it, a value with `,` `;` `=` widened the scope.
  test("review #498: a can whose values hold separators is refused at config time, naming the entry and the value", async () => {
    const cases: Array<[object, string]> = [
      [{ "*": ["read,manage"] }, `permission "read,manage" at "*"`],
      [{ "*": ["all"] }, `permission "all" at "*"`],
      [{ "*": ["read;other=manage"] }, `permission "read;other=manage" at "*"`],
      [{ "safe=read;*": ["manage"] }, `channel pattern "safe=read;*"`],
    ]
    for (const [can, bad] of cases) {
      const message = await configError(await env(await entry(A, { ...agentA, can })))
      expect(message).toContain("BOARD_TOKENS entry 1")
      expect(message).toContain(bad)
    }
  })

  test("a bad permission or a bad pattern is refused, naming it", async () => {
    for (const [can, bad] of [
      [{ "*": ["read", "admin"] }, `permission "admin"`],
      [{ "*": ["Read"] }, `permission "Read"`],
      [{ "*": [""] }, `permission ""`],
      [{ "dev/*": ["read"] }, `channel pattern "dev/*"`],
      [{ "Dev": ["read"] }, `channel pattern "Dev"`],
      [{ "": ["read"] }, `channel pattern ""`],
      [{ "a,b": ["read"] }, `channel pattern "a,b"`],
    ] as Array<[object, string]>) {
      const message = await configError(await env(await entry(A, { ...agentA, can })))
      expect(message).toContain("BOARD_TOKENS entry 1")
      expect(message).toContain(bad)
    }
  })

  test("whitespace in a pattern or a permission is refused, though parseCan would trim it", async () => {
    for (const [can, bad] of [
      [{ " *": ["read"] }, `channel pattern " *"`],
      [{ "dev ": ["read"] }, `channel pattern "dev "`],
      [{ "*": [" read"] }, `permission " read"`],
      [{ "*": ["read "] }, `permission "read "`],
      [{ "*": " all" }, `["can"]["*"]`],
    ] as Array<[object, string]>) {
      const message = await configError(await env(await entry(A, { ...agentA, can })))
      expect(message).toContain("BOARD_TOKENS entry 1")
      expect(message).toContain(bad)
    }
  })

  test("the valid shapes are accepted: *, a channel, a subtree, every permission, an empty list, \"all\"", () => {
    const ok = (can: unknown) => Result.getOrThrow(agentScope(can))
    expect(ok({ "*": ["read", "post", "react", "label", "sync", "manage"] })).toBe("*=read,post,react,label,sync,manage")
    expect(ok({ "fleet2": ["read"], "fleet2/": ["post"], "a/b-c_1/": [] })).toBe("fleet2=read;fleet2/=post;a/b-c_1/=")
    expect(ok({ "*": "all", "security/": [] })).toBe("*=all;security/=")
    expect(ok(DEFAULT_AGENT_CAN)).toBe("*=read,post,react,label")
    for (const bad of [{}, [], ["read"], "all", null, { "*": "everything" }, { "*": [1] }]) expect(Result.isFailure(agentScope(bad))).toBe(true)
  })

  test("an id whose user part is the person's is refused, naming the entry", async () => {
    const message = await configError(await env(await entry(A, agentA), await entry(B, { id: "token:agent:kevin", handle: "kevin-agent" })))
    expect(message).toContain("BOARD_TOKENS entry 2")
    expect(message).toContain("same user")
  })

  test("two entries with the same user part are refused, naming the second", async () => {
    const message = await configError(await env(await entry(A, agentA), await entry(B, { id: "other:agent:implementer-1", handle: "x" })))
    expect(message).toContain("BOARD_TOKENS entry 2")
    expect(message).toContain("same user")
  })
})

/**
 * Guards the one Board internal agent scoping rests on: Board drops a `scope` returned by `authenticate`
 * (hostPrincipal) and reads it only from `request.claims.scope`, the claims object it hands `authenticate`.
 * If a Board upgrade stops passing that object through, this fails, and every agent gets `manage` again.
 */
describe("BOARD UPGRADE GUARD: agent scope reaches Board through request.claims", () => {
  test("agent B cannot cancel, block or reopen agent A's task; A works its own", async () => {
    const A = "agent-a-token-".repeat(4), B = "agent-b-token-".repeat(4)
    const env = {
      ...valid,
      BOARD_TOKENS: JSON.stringify({
        [await sha256Hex(A)]: { id: "token:agent:agent-a", handle: "agent-a" },
        [await sha256Hex(B)]: { id: "token:agent:agent-b", handle: "agent-b" },
      }),
    }
    const authenticate = Effect.runSync(makeTokenAuth.pipe(withEnv(env)))
    const name = "auth-token-guard-" + crypto.randomUUID()
    const driver = nodeSqlDriver(":memory:")
    const unregister = registerDriver(name, driver)
    try {
      const store = { log: a2SqliteStore({ path: name }), tables: sqlTables(boardDb(driver)), close: async () => {} }
      const team = board({ url: "http://127.0.0.1:8799/api/board", backend: a2({ store, blob: memoryBlob() }), authenticate })
      const call = async (token: string, path: string, body: object, headers: Record<string, string> = {}) => {
        const response = await team.fetch(new Request("http://127.0.0.1:8799/api/board" + path, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }))
        return { status: response.status, body: await response.json() as any }
      }
      const created = await call(A, "/tasks", { channel: "work", text: "owned by A", claim: true })
      expect(created.status).toBeLessThan(300)
      const id = String(created.body.task?.id ?? created.body.id)

      for (const [path, body] of [["cancel", { reason: "B cancels" }], ["block", { reason: "B blocks" }], ["reopen", {}]] as const) {
        const refused = await call(B, `/tasks/${id}/${path}`, body)
        expect(refused.status).toBeGreaterThanOrEqual(400)
        expect(JSON.stringify(refused.body)).toMatch(/task_not_owned|forbidden|permission/)
      }
      // B can't buy manage back by sending its own x-board-can.
      expect((await call(B, `/tasks/${id}/cancel`, { reason: "B again" }, { "x-board-can": "*=all" })).status).toBe(403)
      // The person, unscoped, still can.
      expect((await call(TOKEN, `/tasks/${id}/cancel`, { reason: "person cancels" })).status).toBeLessThan(300)
    } finally {
      unregister()
      driver.close()
    }
  })
})
