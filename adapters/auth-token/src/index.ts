import { HttpError } from "@vercel/board"
import { Config, ConfigProvider, Effect, Redacted, Schema } from "effect"

/** Who holds the token: one person. Agents name themselves with `--as <profile>`. */
export type TokenOwner = { id: string; handle: string }

/** What a caller presents: Board passes the bearer token, or nothing. */
export type TokenRequest = { credential?: string | null }

/** The caller a right token stands for. */
export type TokenPrincipal = { id: string; kind: "person"; handle: string }

/** Board's `authenticate`: null when the request is not ours, a principal, or a 401 HttpError. */
export type Authenticate = (request: TokenRequest) => Promise<TokenPrincipal | null>

const Token = Schema.String.check(
  Schema.isMinLength(32, { message: "use a token of at least 32 characters" }),
)

// Board's own rule for a host's principals (auth.mjs hostPrincipal): `<ns>:<kind>:<id>`, never `board:`.
const OwnerId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[^\s+\]]{1,200}$/, {
    message: `owner id must look like "token:user:<name>"`,
  }),
  Schema.makeFilter((id: string) => !id.startsWith("board:") || `owner id must not start with "board:"`),
)

const OwnerHandle = Schema.String.check(
  Schema.isPattern(/^\S{1,64}$/, { message: "owner handle must be 1-64 characters, no spaces" }),
)

/**
 * The token and its owner, read from `BOARD_TOKEN`, `BOARD_OWNER_ID` and `BOARD_OWNER_HANDLE`.
 * A bad value fails with a ConfigError naming the variable; the token is never in the message.
 */
export const TokenAuthConfig: Config.Config<{ token: Redacted.Redacted<string>; owner: TokenOwner }> = Config.all({
  token: Config.schema(Schema.Redacted(Token), "BOARD_TOKEN"),
  owner: Config.all({
    id: Config.schema(OwnerId, "BOARD_OWNER_ID"),
    handle: Config.schema(OwnerHandle, "BOARD_OWNER_HANDLE"),
  }),
})

/** A token that is not this board's. Becomes a 401 HttpError at the Promise edge. */
export class WrongToken extends Schema.TaggedError<WrongToken>()("WrongToken", {}) {}

/** Checks one request against the token. No credential means another verifier may take it. */
const authenticate = Effect.fn("authToken.authenticate")(function* (
  token: Redacted.Redacted<string>,
  owner: TokenOwner,
  request: TokenRequest,
): Effect.fn.Return<TokenPrincipal | null, WrongToken> {
  if (!request.credential) return null
  if (!timingSafeEqual(request.credential, Redacted.value(token))) return yield* new WrongToken()
  return { id: owner.id, kind: "person", handle: owner.handle }
})

/**
 * Reads `TokenAuthConfig` and yields Board's `authenticate`. Each call runs on the context
 * captured here, so it shares the host runtime's logger and tracer.
 */
export const makeTokenAuth: Effect.Effect<Authenticate, Config.ConfigError> = Effect.gen(function* () {
  const { token, owner } = yield* TokenAuthConfig
  const ctx = yield* Effect.context<never>()
  return (request) =>
    Effect.runPromiseWith(ctx)(
      authenticate(token, owner, request).pipe(
        Effect.catchTag("WrongToken", () =>
          Effect.fail(new HttpError(401, "unauthorized", "that token is not this board's"))),
      ),
    )
})

/**
 * The old Promise factory, kept until the host switches to `makeTokenAuth`. Throws on a bad
 * token or owner, as before.
 */
export function tokenAuth(token: string, owner: TokenOwner): Authenticate {
  const provider = ConfigProvider.fromUnknown({
    BOARD_TOKEN: token, BOARD_OWNER_ID: owner.id, BOARD_OWNER_HANDLE: owner.handle,
  })
  return Effect.runSync(makeTokenAuth.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider)))
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
