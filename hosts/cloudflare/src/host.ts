/**
 * The Board inside one Durable Object, as Layers: the object's bindings become services,
 * the Worker env becomes the ConfigProvider, and each adapter's `make<Port>` yields the
 * Promise-shaped port Board consumes. `index.ts` builds one ManagedRuntime from `hostLayer`.
 * No `cloudflare:workers` import here, so tests can build it with fakes.
 */
import { Cause, Config, ConfigProvider, Context, Effect, Layer } from "effect"
import { board } from "@vercel/board"
import { a2, a2SqliteStore, sqlTables } from "@board/internals"
import { boardDb } from "@board/sql"
import { DoSql, DoStorage, doSqlPath } from "@board/sql-do"
import { makeTokenAuth } from "@board/auth-token"
import { makeR2Blob, R2, type Bucket } from "@board/blob-r2"
import { Alarm, makeAlarmScheduler } from "@board/scheduler-alarm"
import { makeOpsHandler, ObjectReset, OPS_PREFIX, OpsStorage } from "./ops.ts"

/** The running Board: every request and alarm of the object goes through here. */
export class BoardHost extends Context.Service<BoardHost, {
  fetch(request: Request): Effect.Effect<Response>
  readonly alarm: Effect.Effect<void>
}>()("board/BoardHost") {}

const makeBoardHost = Effect.fn("host.make")(function* (objectId: string) {
  // Config first, so a bad variable fails before anything touches storage.
  const authenticate = yield* makeTokenAuth
  // Board refuses requests without its public URL outside local dev.
  const url = yield* Config.String("BOARD_PUBLIC_URL").pipe(Config.withDefault(""))
  const driver = yield* DoSql
  const store = { log: a2SqliteStore({ path: doSqlPath(objectId) }), tables: sqlTables(boardDb(driver)), close: async () => {} }
  const scheduler = yield* makeAlarmScheduler(driver)
  const blob = yield* makeR2Blob()
  const team = board({ ...(url ? { url } : {}), backend: a2({ store, scheduler, blob }), authenticate })
  const ops = yield* makeOpsHandler

  return BoardHost.of({
    fetch: Effect.fn("host.fetch")(function* (request: Request) {
      const { pathname } = new URL(request.url)
      yield* Effect.annotateCurrentSpan({ method: request.method, path: pathname })
      return yield* Effect.promise(() => pathname.startsWith(OPS_PREFIX) ? ops(request) : team.fetch(request))
    }),
    // Scheduled posts, watcher retries and a2's drains: whatever is due. Never fails.
    alarm: Effect.promise(() => scheduler.onAlarm()).pipe(Effect.withSpan("host.alarm")),
  })
})

/** What the object hands the host: its platform objects, its id, the Worker env, and how to restart it. */
export type HostBindings = {
  readonly objectId: string
  readonly storage: DoStorage["Service"] & OpsStorage["Service"] & Pick<DurableObjectStorage, "getAlarm" | "setAlarm">
  readonly files: Bucket
  readonly env: object
  readonly reset: (reason: string) => void
}

/** Board on the object's SQLite (registered as `do:<id>` for a2's log store), R2 and alarm; config from `env`. */
export const hostLayer = (b: HostBindings) =>
  Layer.effect(BoardHost, makeBoardHost(b.objectId)).pipe(
    Layer.provide(DoSql.layerRegistered(b.objectId)),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(DoStorage, b.storage),
      Layer.succeed(OpsStorage, b.storage),
      Layer.succeed(R2, b.files),
      Layer.succeed(Alarm, { get: () => b.storage.getAlarm(), set: (at) => b.storage.setAlarm(at) }),
      Layer.succeed(ObjectReset, { reset: b.reset }),
      ConfigProvider.layer(ConfigProvider.fromUnknown(b.env)),
    )),
  )

/**
 * Why the Board could not start, safe to send: a ConfigError names the variable and the
 * rule it broke, never a secret's value (`BOARD_TOKEN` is read as a Redacted schema).
 */
export function startupError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause)
  if (error instanceof Config.ConfigError) return error.message
  if (error !== null && typeof error === "object" && "_tag" in error) return String(error._tag)
  return "board failed to start"
}
