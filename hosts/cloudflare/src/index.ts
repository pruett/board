/**
 * The Cloudflare host: wires adapters, nothing else. One Worker, one Durable Object, one Board.
 * The Worker forwards every request to the object; the object runs Board on its own SQLite,
 * inside one ManagedRuntime built from `hostLayer`.
 */
import { DurableObject } from "cloudflare:workers"
import { ConfigProvider, Effect, Exit, ManagedRuntime } from "effect"
import { BoardHost, hostLayer, startupError } from "./host.ts"
import { OPS_PREFIX, opsAuthorized } from "./ops.ts"

export interface Env {
  BOARD: DurableObjectNamespace<BoardObject>
  /** Attachments, under `files/`. */
  FILES: R2Bucket
  /** A Worker secret: `wrangler secret put BOARD_TOKEN`; `.dev.vars` locally. */
  BOARD_TOKEN: string
  /** A separate Worker secret for `/_ops/*`, at least 32 characters: `wrangler secret put OPS_TOKEN`. Unset: `/_ops/*` answers 404. */
  OPS_TOKEN?: string
  /** Who the token belongs to, e.g. `token:user:pruett`. Not `board:`, which Board reserves. */
  BOARD_OWNER_ID: string
  /** That person's handle, e.g. `pruett`. */
  BOARD_OWNER_HANDLE: string
  /** The Board's public URL, e.g. `https://board.pruett.workers.dev/api/board`. Board refuses requests without it outside local dev. */
  BOARD_PUBLIC_URL?: string
}

/** The one object that holds the Board. */
const BOARD_NAME = "board"

export class BoardObject extends DurableObject<Env> {
  private readonly runtime: ManagedRuntime.ManagedRuntime<BoardHost, unknown>
  /** Set once the runtime is built; `down` instead while it cannot serve. */
  private ready = false
  private down: Response | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.runtime = ManagedRuntime.make(hostLayer({
      objectId: ctx.id.toString(),
      storage: ctx.storage,
      files: env.FILES,
      env,
      reset: (reason) => this.reset(reason),
    }))
    // No request or alarm runs before the Board exists. A failed build is kept, not thrown:
    // a throw here would reset the object and fail the same way on the next request.
    void ctx.blockConcurrencyWhile(async () => {
      const exit = await this.runtime.runPromiseExit(BoardHost.use(() => Effect.void))
      if (Exit.isSuccess(exit)) this.ready = true
      else {
        const detail = startupError(exit.cause)
        console.error("[board] could not start:", detail)
        this.down = Response.json({ error: "board could not start", detail }, { status: 500 })
      }
    })
  }

  override fetch(request: Request): Promise<Response> {
    if (!this.ready) return Promise.resolve(this.down?.clone() ?? Response.json({ error: "board is starting" }, { status: 503 }))
    return this.runtime.runPromise(BoardHost.use((host) => host.fetch(request)))
  }

  override alarm(): Promise<void> {
    if (!this.ready) return Promise.resolve()
    return this.runtime.runPromise(BoardHost.use((host) => host.alarm))
  }

  /**
   * After `/_ops/restore`: dispose the runtime, so its finalizers run (the `do:<id>` SQL
   * driver is unregistered from the isolate-wide stand-in), then reset the object.
   */
  private reset(reason: string): void {
    this.ready = false
    this.down = Response.json({ error: "board is restarting" }, { status: 503 })
    void this.runtime.dispose().finally(() => this.ctx.abort(reason))
  }
}

/** One small runtime per Worker env, for the `/_ops/` token check (`OPS_TOKEN`): config from the env, nothing else. */
const workerRuntimes = new WeakMap<Env, ManagedRuntime.ManagedRuntime<never, never>>()
const workerRuntime = (env: Env) => {
  let runtime = workerRuntimes.get(env)
  if (!runtime) workerRuntimes.set(env, runtime = ManagedRuntime.make(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
  return runtime
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith(OPS_PREFIX)) {
      const authorized = await workerRuntime(env).runPromiseExit(opsAuthorized(request))
      if (Exit.isFailure(authorized))
        return Response.json({ error: "board could not start", detail: startupError(authorized.cause) }, { status: 500 })
      if (authorized.value === "disabled") return Response.json({ error: "no such operation" }, { status: 404 })
      if (authorized.value === "denied") return Response.json({ error: "unauthorized" }, { status: 401 })
    }
    return env.BOARD.get(env.BOARD.idFromName(BOARD_NAME)).fetch(request)
  },
} satisfies ExportedHandler<Env>
