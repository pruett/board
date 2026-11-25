/**
 * `bun run agent <role>`: one machine slot for a worker role (researcher, implementer, reviewer).
 * Waits on the board for the oldest ready task for the role, runs a fresh coding agent on it,
 * and waits again. Settings come from the environment or `.env` (see ./env.ts), plus:
 *   AGENT_MACHINE   the machine half of the profile `<role>-<machine>` (default: the hostname)
 *   AGENT_WAIT      seconds one claim waits on one channel (default 60)
 *   AGENT_CHANNELS  a comma list of channels to look in, instead of every top-level one but hq
 *   AGENT_CLAUDE, AGENT_CODEX  the agent executables (default `claude`, `codex`)
 */
import { hostname } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { Board, isRole, Launcher, roles, work } from "@board/agent"
import { repoRoot } from "./env.ts"

const role = process.argv[2] ?? ""
if (!isRole(role)) {
  console.error(`usage: bun run agent <${roles.join("|")}>`)
  process.exit(2)
}
const machine = (process.env.AGENT_MACHINE || hostname().replace(/\.local$/, "")).toLowerCase()
const profile = `${role}-${machine}`
const waitSeconds = Number(process.env.AGENT_WAIT || 60)
if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
  console.error(`AGENT_WAIT must be a number of seconds, not ${process.env.AGENT_WAIT}`)
  process.exit(2)
}

const layer = Layer.merge(
  Board.cli({ vb: [process.execPath, "--no-env-file", join(repoRoot, "scripts", "vb.ts")], profile }),
  Launcher.layer,
)
const fiber = Effect.runFork(work({
  role,
  profile,
  repo: repoRoot,
  waitSeconds,
  channels: process.env.AGENT_CHANNELS || undefined,
  exe: { claude: process.env.AGENT_CLAUDE || "claude", codex: process.env.AGENT_CODEX || "codex" },
}).pipe(Effect.provide(layer)))

/** On SIGINT/SIGTERM: interrupt the loop (which kills the agent and releases a held claim), then exit 0. */
let stopping = false
const stop = (signal: string) => {
  if (stopping) return
  stopping = true
  console.log(`${new Date().toISOString()} ${profile} ${signal}: stopping`)
  Effect.runFork(Fiber.interrupt(fiber))
}
process.on("SIGINT", () => stop("SIGINT"))
process.on("SIGTERM", () => stop("SIGTERM"))

const exit = await Effect.runPromise(Fiber.await(fiber))
if (stopping) {
  console.log(`${new Date().toISOString()} ${profile} stopped`)
  process.exit(0)
}
console.error(`${profile} stopped:`, exit)
process.exit(1)
