/**
 * `bun run agent <role>`: one machine slot for a worker role (researcher, implementer, reviewer).
 * Waits on the board for the oldest ready task for the role, runs a fresh coding agent on it,
 * and waits again.
 * `bun run agent lead <project>`: the project's lead, profile lead-<project>; one fresh agent per
 * task completed, blocked or failed in the project's channel, or goal for it in hq.
 * `bun run agent k2`: the chief of staff, profile k2; one fresh agent per lead's question in hq
 * (label ask=…) or message from the owner there.
 * Settings come from the environment or `.env` (see ./env.ts), plus:
 *   AGENT_MACHINE   the machine half of a worker's profile `<role>-<machine>` (default: the hostname)
 *   AGENT_WAIT      seconds one claim waits on one channel (default 60), or one round of a lead's or k2's waits (default 600)
 *   AGENT_CHANNELS  a comma list of channels a worker looks in, instead of every top-level one but hq
 *   AGENT_OWNER     the person whose hq messages wake k2 (default pruett)
 *   AGENT_CLAUDE, AGENT_CODEX  the agent executables (default `claude`, `codex`)
 */
import { hostname } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { Board, isRole, k2Program, Launcher, leadProgram, roles, watch, work } from "@board/agent"
import { repoRoot } from "./env.ts"

const [program = "", project = ""] = process.argv.slice(2)
const usage = `usage: bun run agent <${roles.join("|")}> | bun run agent lead <project> | bun run agent k2`
const coordinator = program === "lead" || program === "k2"
if (!(isRole(program) || coordinator) || (program === "lead" && (project === "" || project === "hq"))) {
  console.error(usage)
  process.exit(2)
}
const machine = (process.env.AGENT_MACHINE || hostname().replace(/\.local$/, "")).toLowerCase()
const profile = program === "lead" ? `lead-${project}` : program === "k2" ? "k2" : `${program}-${machine}`
const waitSeconds = Number(process.env.AGENT_WAIT || (coordinator ? 600 : 60))
if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
  console.error(`AGENT_WAIT must be a number of seconds, not ${process.env.AGENT_WAIT}`)
  process.exit(2)
}
const exe = { claude: process.env.AGENT_CLAUDE || "claude", codex: process.env.AGENT_CODEX || "codex" }

const layer = Layer.merge(
  Board.cli({ vb: [process.execPath, "--no-env-file", join(repoRoot, "scripts", "vb.ts")], profile }),
  Launcher.layer,
)
const options = { repo: repoRoot, waitSeconds, exe }
const main = program === "lead"
  ? leadProgram(project, options).pipe(Effect.flatMap(watch))
  : program === "k2"
  ? k2Program(process.env.AGENT_OWNER || "pruett", options).pipe(Effect.flatMap(watch))
  : isRole(program)
  ? work({ role: program, profile, repo: repoRoot, waitSeconds, channels: process.env.AGENT_CHANNELS || undefined, exe })
  : Effect.die(usage)
const fiber = Effect.runFork(main.pipe(Effect.provide(layer)))

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
