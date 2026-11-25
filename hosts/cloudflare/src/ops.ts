/**
 * Operator routes under `/_ops/`, behind their own `OPS_TOKEN` bearer secret: the Board's
 * token does not open them. They reach Cloudflare's point-in-time restore, which only code
 * inside the object can call. Without `OPS_TOKEN` set they answer 404, so the operator surface
 * does not exist (and is not hinted at, as a 503 would) until it is configured.
 *
 *   GET  /_ops/bookmark              the storage's current bookmark
 *   POST /_ops/restore {"at": iso}         restore SQLite as it was at `at` (last 30 days), then restart
 *   POST /_ops/restore {"bookmark": "…"}   restore to a bookmark from /_ops/bookmark: exact, no clock skew
 */
import { Config, Context, DateTime, Effect, Redacted, Schema, Tracer, type Scope } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

export const OPS_PREFIX = "/_ops/"

/** The part of the object's storage the restore routes use. */
export class OpsStorage extends Context.Service<
  OpsStorage,
  Pick<DurableObjectStorage, "getCurrentBookmark" | "getBookmarkForTime" | "onNextSessionRestoreBookmark">
>()("board/OpsStorage") {}

/** Restarts the object (the host disposes its runtime, then `ctx.abort`s), so the next request opens the restored database. */
export class ObjectReset extends Context.Service<ObjectReset, { reset(reason: string): void }>()("board/ObjectReset") {}

/** A restore target: a bookmark from `/_ops/bookmark`, or a time. With both, the bookmark wins and `at` is echoed. */
export const RestoreBody = Schema.Union([
  Schema.Struct({ bookmark: Schema.NonEmptyString, at: Schema.optional(Schema.DateFromString) }),
  Schema.Struct({ at: Schema.DateFromString }),
])

const badBody = HttpServerResponse.jsonUnsafe(
  { error: 'send {"bookmark": "<from /_ops/bookmark>"} or {"at": "<ISO time>"}' },
  { status: 400 },
)

const bookmark = HttpRouter.route("GET", "/_ops/bookmark", Effect.gen(function* () {
  const storage = yield* OpsStorage
  const bookmark = yield* Effect.promise(() => storage.getCurrentBookmark())
  return HttpServerResponse.jsonUnsafe({ bookmark, at: DateTime.formatIso(yield* DateTime.now) })
}))

const restore = HttpRouter.route("POST", "/_ops/restore", Effect.gen(function* () {
  const body = yield* HttpServerRequest.schemaBodyJson(RestoreBody).pipe(Effect.option)
  if (body._tag === "None") return badBody
  const storage = yield* OpsStorage
  const { reset } = yield* ObjectReset
  const target = body.value
  const bookmark = "bookmark" in target
    ? target.bookmark
    : yield* Effect.promise(() => storage.getBookmarkForTime(target.at))
  yield* Effect.promise(() => storage.onNextSessionRestoreBookmark(bookmark))
  // Restart after this answer is sent; the next request opens the restored database.
  yield* Effect.sleep("50 millis").pipe(Effect.andThen(Effect.sync(() => reset("restoring to " + bookmark))), Effect.forkDetach)
  return HttpServerResponse.jsonUnsafe({ restoring: bookmark, ...(target.at ? { at: target.at.toISOString() } : {}) })
}))

const notFound = HttpRouter.route("*", "/_ops/*", HttpServerResponse.jsonUnsafe({ error: "no such operation" }, { status: 404 }))

const OpsRoutes = HttpRouter.addAll([bookmark, restore, notFound])

/**
 * The `/_ops/` routes as a fetch handler. Each request runs on the context captured here,
 * so it shares the host runtime's logger, tracer and clock.
 */
export const makeOpsHandler: Effect.Effect<
  (request: Request) => Promise<Response>,
  never,
  OpsStorage | ObjectReset | Scope.Scope
> = Effect.gen(function* () {
  const http = (yield* HttpRouter.toHttpEffect(OpsRoutes)).pipe(
    // A storage call that threw: log the cause here, answer JSON like every other route.
    Effect.catchCause((cause) =>
      Effect.as(Effect.logError("[board] /_ops/ failed", cause), HttpServerResponse.jsonUnsafe({ error: "operation failed" }, { status: 500 }))),
  )
  // Without the startup span: each request is its own trace, not a child of `host.make`.
  const ctx = Context.omit(Tracer.ParentSpan)(yield* Effect.context<OpsStorage | ObjectReset>())
  const handler = HttpEffect.toWebHandlerWith<
    OpsStorage | ObjectReset,
    OpsStorage | ObjectReset | Scope.Scope | HttpServerRequest.HttpServerRequest
  >(ctx)(http)
  // Exact paths only: the router also matches case variants, a trailing slash and doubled slashes.
  return (request) => OPS_PATHS.has(new URL(request.url).pathname) ? handler(request) : Promise.resolve(noSuchOperation())
})

const OPS_PATHS = new Set(["/_ops/bookmark", "/_ops/restore"])
const noSuchOperation = () => Response.json({ error: "no such operation" }, { status: 404 })

const OpsToken = Schema.String.check(
  Schema.isMinLength(32, { message: "use a token of at least 32 characters" }),
)

/**
 * The Worker checks the token for `/_ops/` itself: Board's auth does not see these routes.
 * Reads `OPS_TOKEN` as a Redacted value, at least 32 characters; the compare takes the same
 * time wherever it differs. `"disabled"` when `OPS_TOKEN` is unset; a set but short one fails
 * with a ConfigError that names the variable, never the value.
 */
export const opsAuthorized = Effect.fn("ops.authorized")(function* (request: Request) {
  const present = yield* Config.option(Config.Redacted("OPS_TOKEN"))
  if (present._tag === "None") return "disabled" as const
  const token = yield* Config.schema(Schema.Redacted(OpsToken), "OPS_TOKEN")
  return timingSafeEqual(request.headers.get("authorization") ?? "", `Bearer ${Redacted.value(token)}`) ? "ok" as const : "denied" as const
})

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
