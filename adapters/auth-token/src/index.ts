import { HttpError } from "@vercel/board"
import { compileAccess, parseCan, PERMISSIONS } from "@vercel/board/access"
import { Config, ConfigProvider, Context, Effect, Option, Redacted, Result, Schema, Tracer } from "effect"

/** Who holds a token: the person, from `BOARD_OWNER_*`, or one agent, from `BOARD_TOKENS`. */
export type TokenOwner = { id: string; handle: string }

/** One agent: who it is, and its scope as `x-board-can` text (`*=read,post,react,label`). */
export type AgentOwner = TokenOwner & { scope: string }

/**
 * What a caller presents: Board passes the bearer token, or nothing, and the request's claims.
 * `claims.scope` is the request's `x-board-can`; for an agent token the adapter writes it.
 */
export type TokenRequest = { credential?: string | null; claims?: { scope: string | null } }

/**
 * The caller a right token stands for. Agents are `person` too: Board's `hostPrincipal` takes
 * person, deployment, workflow or external, and only a person is let in by grants naming it
 * (`--user <name>`); any other host principal is refused unless it is a Vercel deployment.
 * Board's `hostPrincipal` keeps only these fields, so an agent's scope travels in `claims.scope`.
 */
export type TokenPrincipal = { id: string; kind: "person"; handle: string }

/** What an agent may do when its entry names no `can`: read, post, react and label on every channel, never manage or sync. */
export const DEFAULT_AGENT_CAN = { "*": ["read", "post", "react", "label"] } as const

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
 * Why a `can` isn't a grant's can, naming the bad pattern or permission, or true. It runs on the structure, before
 * `canText` joins it with `,` `;` `=`: checked only as header text, `{"*": ["read,manage"]}` would become manage.
 * A pattern is what Board's own `compileAccess` takes (`*`, a channel, or a channel and its subtree), a permission
 * one of Board's `PERMISSIONS`, and `"all"` only as a pattern's whole grant, as Board's grants take it.
 */
function canProblem(can: Readonly<Record<string, "all" | ReadonlyArray<string>>>): string | true {
  for (const [pattern, grant] of Object.entries(can)) {
    try {
      compileAccess({ [pattern]: [] })
    } catch {
      return `channel pattern ${JSON.stringify(pattern)} must be *, a channel (fleet2), or a channel and its subtree (fleet2/)`
    }
    if (grant === "all") continue
    for (const permission of grant) {
      if (!(PERMISSIONS as ReadonlyArray<string>).includes(permission)) {
        return `permission ${JSON.stringify(permission)} at ${JSON.stringify(pattern)} must be one of ${PERMISSIONS.join(", ")}`
      }
    }
  }
  return true
}

// A grant's `can`: channel pattern -> a list of Board's permissions, or "all". parseCan still checks the header text after.
const AgentCan = Schema.Record(Schema.String, Schema.Union([Schema.Literal("all"), Schema.Array(Schema.String)]))
  .check(Schema.makeFilter(canProblem))

const AgentEntry = Schema.Struct({ id: OwnerId, handle: OwnerHandle, can: Schema.optional(AgentCan) })

/** A checked `can` object as `x-board-can` text: `{"dev/": ["read"], "*": "all"}` is `dev/=read;*=all`. */
function canText(can: Readonly<Record<string, "all" | ReadonlyArray<string>>>): string {
  return Object.entries(can).map(([pattern, grant]) => `${pattern}=${grant === "all" ? "all" : grant.join(",")}`).join(";")
}

/** A schema failure on one line: `permission "read,manage" at "*" must be … at ["can"]`. */
const oneLine = (error: Schema.SchemaError) => error.message.replace(/\n\s*/g, " ")

/**
 * A `can` as `x-board-can` text, or why not: checked as a structure (`AgentCan`), then as header text by Board's
 * `parseCan`. `name` is what messages call it. mint.ts and `BOARD_TOKENS` both go through here.
 */
export function agentScope(can: unknown, name = "can"): Result.Result<string, string> {
  const checked = Schema.decodeUnknownResult(AgentCan)(can)
  if (Result.isFailure(checked)) return Result.fail(`${name}: ${oneLine(checked.failure)}`)
  const scope = canText(checked.success)
  try {
    parseCan(scope, name)
  } catch (error) {
    return Result.fail(error instanceof Error ? error.message : `${name} is not a valid grant`)
  }
  return Result.succeed(scope)
}

/** The user Board's grants see in a principal id: everything after the second colon (Board's `userIdOf`). */
const userPart = (id: string) => id.split(":").slice(2).join(":")

/** sha256 of a token, as 64 lowercase hex characters: the only form a token is stored in. */
export async function sha256Hex(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

const HASH = /^[0-9a-f]{64}$/
const ENTRY = `{"<sha256 hex of the token>": {"id": "token:agent:<name>", "handle": "<name>", "can": {"*": ["read","post","react","label"]}}}`

/**
 * `BOARD_TOKENS` as hash -> owner, or why not. Messages name entries by position and never quote
 * the text: a token pasted where its hash belongs must not end up in a log.
 */
function parseAgentTokens(json: string, person: TokenOwner): Result.Result<ReadonlyMap<string, AgentOwner>, string> {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return Result.fail(`BOARD_TOKENS is not JSON; it must be an object like ${ENTRY}`)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return Result.fail(`BOARD_TOKENS must be a JSON object like ${ENTRY}`)
  }
  const owners = new Map<string, AgentOwner>()
  const ids = new Set([person.id]), handles = new Set([person.handle]), users = new Set([userPart(person.id)])
  for (const [i, [hash, value]] of Object.entries(raw).entries()) {
    const at = `BOARD_TOKENS entry ${i + 1}`
    if (!HASH.test(hash)) return Result.fail(`${at}: key must be a token's sha256 as 64 lowercase hex characters (make one with mint.ts)`)
    const entry = Schema.decodeUnknownResult(AgentEntry)(value)
    if (Result.isFailure(entry)) {
      return Result.fail(`${at}: ${oneLine(entry.failure)}; value must be {"id": "token:agent:<name>", "handle": "<name>"} with an optional "can": {"<channel pattern>": ["read", ...]}`)
    }
    const { id, handle, can } = entry.success
    if (ids.has(id)) return Result.fail(`${at}: id is already taken by BOARD_OWNER_ID or another entry`)
    if (users.has(userPart(id))) {
      return Result.fail(`${at}: id ends in the same user as BOARD_OWNER_ID or another entry (the part after the second colon); Board's grants would treat them as one user`)
    }
    if (handles.has(handle)) return Result.fail(`${at}: handle is already taken by BOARD_OWNER_HANDLE or another entry`)
    const checked = agentScope(can ?? DEFAULT_AGENT_CAN, `${at} can`)
    if (Result.isFailure(checked)) return Result.fail(checked.failure)
    const scope = checked.success
    ids.add(id)
    users.add(userPart(id))
    handles.add(handle)
    owners.set(hash, { id, handle, scope })
  }
  return Result.succeed(owners)
}

/**
 * The person's token and owner, from `BOARD_TOKEN`, `BOARD_OWNER_ID` and `BOARD_OWNER_HANDLE`, and the
 * agents' tokens, from the optional `BOARD_TOKENS`: a JSON object of sha256 hex -> `{ id, handle, can? }`,
 * where `can` defaults to `DEFAULT_AGENT_CAN`.
 * A bad value fails with a ConfigError naming the variable; no token is ever in the message.
 */
export const TokenAuthConfig: Config.Config<{
  token: Redacted.Redacted<string>
  owner: TokenOwner
  agents: ReadonlyMap<string, AgentOwner>
}> = Config.all({
  token: Config.schema(Schema.Redacted(Token), "BOARD_TOKEN"),
  owner: Config.all({
    id: Config.schema(OwnerId, "BOARD_OWNER_ID"),
    handle: Config.schema(OwnerHandle, "BOARD_OWNER_HANDLE"),
  }),
  agentsJson: Config.option(Config.Redacted("BOARD_TOKENS")),
}).pipe(Config.flatMap(({ token, owner, agentsJson }) => {
  if (Option.isNone(agentsJson)) return Config.succeed({ token, owner, agents: new Map<string, AgentOwner>() as ReadonlyMap<string, AgentOwner> })
  return Result.match(parseAgentTokens(Redacted.value(agentsJson.value), owner), {
    onFailure: (message) => Config.fail(new ConfigProvider.SourceError({ message })),
    onSuccess: (agents) => Config.succeed({ token, owner, agents }),
  })
}))

/** A token that is not this board's. Becomes a 401 HttpError at the Promise edge. */
export class WrongToken extends Schema.TaggedError<WrongToken>()("WrongToken", {}) {}

/** An agent token on a request that sent its own `x-board-can`, or with no claims to scope. Becomes a 403. */
export class AgentScopeRefused extends Schema.TaggedError<AgentScopeRefused>()("AgentScopeRefused", {}) {}

/**
 * Checks one request: the person's token, then the agents' by hash. No credential means another verifier may take it.
 * An agent's scope goes into `request.claims.scope`, the one place Board reads a principal's scope from: Board hands
 * `authenticate` the same claims object `identify` reads after it, and never caches a host's principal, so this runs
 * on every request. The board-scope regression test in test/auth-token.test.ts fails if a Board upgrade breaks it.
 */
const authenticate = Effect.fn("authToken.authenticate")(function* (
  token: Redacted.Redacted<string>,
  owner: TokenOwner,
  agents: ReadonlyMap<string, AgentOwner>,
  request: TokenRequest,
): Effect.fn.Return<TokenPrincipal | null, WrongToken | AgentScopeRefused> {
  const credential = request.credential
  if (!credential) return null
  if (timingSafeEqual(credential, Redacted.value(token))) return { id: owner.id, kind: "person", handle: owner.handle }
  // Looked up by hash, so timing says nothing about any token.
  const agent = agents.size === 0 ? undefined : agents.get(yield* Effect.promise(() => sha256Hex(credential)))
  if (!agent) return yield* new WrongToken()
  // Fail closed: without claims there is nowhere to put the scope, and a client's own scope would replace ours.
  if (!request.claims || request.claims.scope !== null) return yield* new AgentScopeRefused()
  request.claims.scope = agent.scope
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
        Effect.catchTags({
          WrongToken: () => Effect.fail(new HttpError(401, "unauthorized", "that token is not this board's")),
          AgentScopeRefused: () => Effect.fail(new HttpError(403, "forbidden",
            "an agent token can't send x-board-can: an agent's scope is the can in its BOARD_TOKENS entry, and an agent can't widen or narrow its own scope")),
        }),
      ),
    )
})

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
