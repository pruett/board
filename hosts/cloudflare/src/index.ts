/**
 * The Cloudflare host: wires adapters, nothing else. One Worker, one Durable Object, one Board.
 * The Worker forwards every request to the object; the object runs Board on its own SQLite.
 */
import { DurableObject } from "cloudflare:workers"
import { board } from "@vercel/board"
import { a2, a2SqliteStore, localScheduler, memoryBlob, sqlTables } from "@board/internals"
import { boardDb, registerDriver } from "@board/sql"
import { doSqlDriver } from "@board/sql-do"
import { tokenAuth } from "@board/auth-token"

export interface Env {
  BOARD: DurableObjectNamespace<BoardObject>
  /** A Worker secret: `wrangler secret put BOARD_TOKEN`; `.dev.vars` locally. */
  BOARD_TOKEN: string
  /** Who the token belongs to, e.g. `token:user:pruett`. Not `board:`, which Board reserves. */
  BOARD_OWNER_ID: string
  /** That person's handle, e.g. `pruett`. */
  BOARD_OWNER_HANDLE: string
}

/** The one object that holds the Board. */
const BOARD_NAME = "board"

export class BoardObject extends DurableObject<Env> {
  private readonly team: ReturnType<typeof board>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const driver = doSqlDriver(ctx.storage)
    const path = `do:${ctx.id.toString()}`
    registerDriver(path, driver)
    const store = { log: a2SqliteStore({ path }), tables: sqlTables(boardDb(driver)), close: async () => {} }
    this.team = board({
      // TODO(blob-r2, scheduler-alarm): memoryBlob and localScheduler lose attachments and timers on restart.
      backend: a2({ store, scheduler: localScheduler(), blob: memoryBlob() }),
      authenticate: tokenAuth(env.BOARD_TOKEN, { id: env.BOARD_OWNER_ID, handle: env.BOARD_OWNER_HANDLE }),
    })
  }

  override fetch(request: Request): Promise<Response> {
    return this.team.fetch(request)
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.BOARD.get(env.BOARD.idFromName(BOARD_NAME)).fetch(request)
  },
} satisfies ExportedHandler<Env>
