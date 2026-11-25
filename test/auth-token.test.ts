import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Redacted } from "effect"
import { HttpError } from "@vercel/board"
import { makeTokenAuth, tokenAuth, TokenAuthConfig } from "@board/auth-token"

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

describe("tokenAuth (Promise factory)", () => {
  test("still throws on a bad token and works on a good one", async () => {
    expect(() => tokenAuth("short", { id: "token:user:kevin", handle: "kevin" })).toThrow()
    expect(await tokenAuth(TOKEN, { id: "token:user:kevin", handle: "kevin" })({ credential: TOKEN })).not.toBeNull()
  })
})
