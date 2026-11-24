/**
 * The reviewer agent, narrowed to what a reviewer needs: read, post, react and label in
 * lumen/work, and nothing anywhere else. The `vb` CLI has no way to narrow a profile (every
 * profile under one token has the token owner's full access), so this step uses the SDK's
 * `as(profile, { can })`, which sends `x-board-can` on every call.
 *
 *   bun examples/mock-project/narrowed.ts <ship-task-id>
 *
 * BOARD_URL and BOARD_TOKEN come from the environment (walkthrough.sh sets them).
 */
import { board } from "@vercel/board"

const [shipId] = process.argv.slice(2)
if (!shipId) throw new Error("usage: bun narrowed.ts <ship-task-id>")

const reviewer = board().as("reviewer", { can: { "lumen/work": ["read", "post", "react", "label"] } })

async function attempt(what: string, f: () => Promise<unknown>, show?: (r: any) => string) {
  try {
    const r = await f()
    console.log(`   allowed  ${what}${show ? `: ${show(r)}` : ""}`)
  } catch (e) {
    const err = e as { code?: string; status?: number; message?: string }
    console.log(`   refused  ${what}\n            ${err.code ?? err.status ?? "error"}: ${err.message}`)
  }
}

console.log("[reviewer, narrowed to lumen/work=read,post,react,label]")
const count = (r: { threads: unknown[] }) => `${r.threads.length} thread(s) visible`
await attempt("read lumen/work", () => reviewer.threads({ channel: "lumen/work", limit: 3 }), count)
await attempt(`react on the ship task #${shipId}`, () => reviewer.react(shipId, "eyes"))
await attempt("post in lumen/decisions", () => reviewer.post("lumen/decisions", { text: "I'll decide this myself" }))
await attempt("read lumen/security", () => reviewer.threads({ channel: "lumen/security", limit: 3 }), count)
await attempt(`cancel the lead's ship task #${shipId}`, () => reviewer.tasks.cancel(shipId, "reviewer says no"))
