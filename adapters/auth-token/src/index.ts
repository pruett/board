import { HttpError } from "@vercel/board"
import { Config, ConfigProvider, Context, Effect, Option, Redacted, Result, Schema, Tracer } from "effect"

/** Who holds a token: the person, from `BOARD_OWNER_*`, or one agent, from `BOARD_TOKENS`. */
export type TokenOwner = { id: string; handle: string }

/** What a caller presents: Board passes the bearer token, or nothing. */
export type TokenRequest = { credential?: string | null }

/**
 * The caller a right token stands for. Agents are `person` too: Board's `hostPrincipal` takes
 * person, deployment, workflow or external, and only a person is let in by grants naming it
 * (`--user <name>`); any other host principal is refused unless it is a Vercel deployment.
 */
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

const AgentOwner = Schema.Struct({ id: OwnerId, handle: OwnerHandle })

/** sha256 of a token, as 64 lowercase hex characters: the only form a token is stored in. */
export async function sha256Hex(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

const HASH = /^[0-9a-f]{64}$/
const ENTRY = `{"<sha256 hex of the token>": {"id": "token:agent:<name>", "handle": "<name>"}}`

/**
 * `BOARD_TOKENS` as hash -> owner, or why not. Messages name entries by position and never quote
 * the text: a token pasted where its hash belongs must not end up in a log.
 */
function parseAgentTokens(json: string, person: TokenOwner): Result.Result<ReadonlyMap<string, TokenOwner>, string> {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return Result.fail(`BOARD_TOKENS is not JSON; it must be an object like ${ENTRY}`)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return Result.fail(`BOARD_TOKENS must be a JSON object like ${ENTRY}`)
  }
  const owners = new Map<string, TokenOwner>()
  const ids = new Set([person.id]), handles = new Set([person.handle])
  for (const [i, [hash, value]] of Object.entries(raw).entries()) {
    const at = `BOARD_TOKENS entry ${i + 1}`
    if (!HASH.test(hash)) return Result.fail(`${at}: key must be a token's sha256 as 64 lowercase hex characters (make one with mint.ts)`)
    const owner = Schema.decodeUnknownOption(AgentOwner)(value)
    if (Option.isNone(owner)) return Result.fail(`${at}: value must be {"id": "token:agent:<name>", "handle": "<name>"}`)
    if (ids.has(owner.value.id)) return Result.fail(`${at}: id is already taken by BOARD_OWNER_ID or another entry`)
    if (handles.has(owner.value.handle)) return Result.fail(`${at}: handle is already taken by BOARD_OWNER_HANDLE or another entry`)
    ids.add(owner.value.id)
    handles.add(owner.value.handle)
    owners.set(hash, owner.value)
  }
  return Result.succeed(owners)
}

/**
 * The person's token and owner, from `BOARD_TOKEN`, `BOARD_OWNER_ID` and `BOARD_OWNER_HANDLE`, and the
 * agents' tokens, from the optional `BOARD_TOKENS`: a JSON object of sha256 hex -> `{ id, handle }`.
 * A bad value fails with a ConfigError naming the variable; no token is ever in the message.
 */
export const TokenAuthConfig: Config.Config<{
  token: Redacted.Redacted<string>
  owner: TokenOwner
  agents: ReadonlyMap<string, TokenOwner>
}> = Config.all({
  token: Config.schema(Schema.Redacted(Token), "BOARD_TOKEN"),
  owner: Config.all({
    id: Config.schema(OwnerId, "BOARD_OWNER_ID"),
    handle: Config.schema(OwnerHandle, "BOARD_OWNER_HANDLE"),
  }),
  agentsJson: Config.option(Config.Redacted("BOARD_TOKENS")),
}).pipe(Config.flatMap(({ token, owner, agentsJson }) => {
  if (Option.isNone(agentsJson)) return Config.succeed({ token, owner, agents: new Map<string, TokenOwner>() as ReadonlyMap<string, TokenOwner> })
  return Result.match(parseAgentTokens(Redacted.value(agentsJson.value), owner), {
    onFailure: (message) => Config.fail(new ConfigProvider.SourceError({ message })),
    onSuccess: (agents) => Config.succeed({ token, owner, agents }),
  })
}))

/** A token that is not this board's. Becomes a 401 HttpError at the Promise edge. */
export class WrongToken extends Schema.TaggedError<WrongToken>()("WrongToken", {}) {}

/** Checks one request: the person's token, then the agents' by hash. No credential means another verifier may take it. */
const authenticate = Effect.fn("authToken.authenticate")(function* (
  token: Redacted.Redacted<string>,
  owner: TokenOwner,
  agents: ReadonlyMap<string, TokenOwner>,
  request: TokenRequest,
): Effect.fn.Return<TokenPrincipal | null, WrongToken> {
  const credential = request.credential
  if (!credential) return null
  if (timingSafeEqual(credential, Redacted.value(token))) return { id: owner.id, kind: "person", handle: owner.handle }
  // Looked up by hash, so timing says nothing about any token.
  const agent = agents.size === 0 ? undefined : agents.get(yield* Effect.promise(() => sha256Hex(credential)))
  if (!agent) return yield* new WrongToken()
  return { id: agent.id, kind: "person", handle: agent.handle }
})

/**
 * Reads `TokenAuthConfig` and yields Board's `authenticate`. Each call runs on the context
 * captured here, so it shares the host runtime's logger and tracer.
 */
export const makeTokenAuth: Effect.Effect<Authenticate, Config.ConfigError> = Effect.gen(function* () {
  const { token, owner, agents } = yield* TokenAuthConfig
  const ctx = Context.omit(Tracer.ParentSpan)(yield* Effect.context<never>())
  return (request) =>
    Effect.runPromiseWith(ctx)(
      authenticate(token, owner, agents, request).pipe(
        Effect.catchTag("WrongToken", () =>
          Effect.fail(new HttpError(401, "unauthorized", "that token is not this board's"))),
      ),
    )
})

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
