/**
 * The Cloudflare host: wires adapters, nothing else. One Worker, one Durable Object, one Board.
 * The Worker forwards every request to the object; the object runs Board on its own SQLite.
 */
import { DurableObject } from "cloudflare:workers"
import { board } from "@vercel/board"
import { a2, a2SqliteStore, sqlTables } from "@board/internals"
import { boardDb, registerDriver } from "@board/sql"
import { doSqlDriver } from "@board/sql-do"
import { tokenAuth } from "@board/auth-token"
import { r2Blob } from "@board/blob-r2"
import { alarmScheduler, type AlarmScheduler } from "@board/scheduler-alarm"
import { handleOps, OPS_PREFIX, opsAuthorized } from "./ops.ts"

export interface Env {
  BOARD: DurableObjectNamespace<BoardObject>
  /** Attachments, under `files/`. */
  FILES: R2Bucket
  /** A Worker secret: `wrangler secret put BOARD_TOKEN`; `.dev.vars` locally. */
  BOARD_TOKEN: string
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
  private readonly team: ReturnType<typeof board>
  private readonly scheduler: AlarmScheduler

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const driver = doSqlDriver(ctx.storage)
    const path = `do:${ctx.id.toString()}`
    registerDriver(path, driver)
    const store = { log: a2SqliteStore({ path }), tables: sqlTables(boardDb(driver)), close: async () => {} }
    this.scheduler = alarmScheduler(driver, {
      get: () => ctx.storage.getAlarm(),
      set: (at) => ctx.storage.setAlarm(at),
    })
    this.team = board({
      ...(env.BOARD_PUBLIC_URL ? { url: env.BOARD_PUBLIC_URL } : {}),
      backend: a2({ store, scheduler: this.scheduler, blob: r2Blob(env.FILES) }),
      authenticate: tokenAuth(env.BOARD_TOKEN, { id: env.BOARD_OWNER_ID, handle: env.BOARD_OWNER_HANDLE }),
    })
  }

  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith(OPS_PREFIX)) return handleOps(request, this.ctx)
    return this.team.fetch(request)
  }

  /** Scheduled posts, watcher retries and a2's drains: whatever is due. */
  override alarm(): Promise<void> {
    return this.scheduler.onAlarm()
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith(OPS_PREFIX) && !opsAuthorized(request, env.BOARD_TOKEN))
      return Response.json({ error: "unauthorized" }, { status: 401 })
    return env.BOARD.get(env.BOARD.idFromName(BOARD_NAME)).fetch(request)
  },
} satisfies ExportedHandler<Env>
