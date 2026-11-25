import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Redacted } from "effect"
import { HttpError } from "@vercel/board"
import { makeTokenAuth, sha256Hex, TokenAuthConfig } from "@board/auth-token"

const TOKEN = "t".repeat(32)
const valid = { BOARD_TOKEN: TOKEN, BOARD_OWNER_ID: "token:user:kevin", BOARD_OWNER_HANDLE: "kevin" }

const withEnv = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))

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
    expect(await authenticate({ credential: A })).toEqual({ id: "token:agent:implementer-1", kind: "person", handle: "implementer-1" })
    expect(await authenticate({ credential: B })).toEqual({ id: "token:agent:implementer-2", kind: "person", handle: "implementer-2" })
    expect(await authenticate({ credential: TOKEN })).toEqual({ id: "token:user:kevin", kind: "person", handle: "kevin" })
    expect(await authenticate({})).toBeNull()
  })

  test("an unknown token is a 401, and a removed entry's token too", async () => {
    const env = await agentsEnv()
    const onlyA = { ...env, BOARD_TOKENS: JSON.stringify({ [await sha256Hex(A)]: { id: "token:agent:implementer-1", handle: "implementer-1" } }) }
    const authenticate = Effect.runSync(makeTokenAuth.pipe(withEnv(onlyA)))
    for (const credential of ["x".repeat(32), B]) {
      const error = await authenticate({ credential }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).status).toBe(401)
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
