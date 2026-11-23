import { DurableObject } from "cloudflare:workers";
import process from "node:process";
import * as shim from "./sqlite-shim.mjs";
const orig = process.getBuiltinModule?.bind(process);
process.getBuiltinModule = (n) => (n === "node:sqlite" || n === "sqlite" ? shim : orig?.(n));
globalThis.__shimLog = [];

export class FleetBoard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    globalThis.__doSql = ctx.storage.sql;
    this.ready = (async () => {
      const { board } = await import("@vercel/board");
      const { local } = await import("@vercel/board/backend-local");
      this.team = board({
        backend: local({ dir: "/tmp/board" }),
        authenticate: async (req) => {
          if (!req.credential) return null;
          if (req.credential !== env.FLEET_TOKEN) throw Object.assign(new Error("bad token"), { status: 401 });
          return { id: "fleet:user:pruett", kind: "person", handle: "pruett" };
        },
      });
    })();
  }
  async fetch(req) {
    await this.ready;
    if (new URL(req.url).pathname === "/_shimlog") return Response.json(globalThis.__shimLog);
    return this.team.fetch(req);
  }
}
export default {
  async fetch(req, env) {
    return env.BOARD.get(env.BOARD.idFromName("flight")).fetch(req);
  },
};
