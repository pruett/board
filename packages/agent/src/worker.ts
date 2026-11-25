/**
 * One machine slot for one role: wait on the board for the oldest ready task, run a fresh agent
 * on it, keep the lease alive while it runs, settle the task if the agent did not, wait again.
 */
import { join } from "node:path"
import { Clock, Console, DateTime, Duration, Effect, Option } from "effect"
import { Board, BoardError, type Task } from "./Board.ts"
import { projectChannels } from "./channels.ts"
import { Launcher } from "./Launcher.ts"
import { buildPrompt } from "./prompt.ts"
import { agentFor, type Executables, launchArgv, type Role } from "./roles.ts"

export interface WorkerConfig {
  readonly role: Role
  readonly profile: string
  /** The repo root: the agent's cwd, where `vb` runs, and where `.agent/` logs go. */
  readonly repo: string
  /** How long one claim waits on one channel. */
  readonly waitSeconds: number
  /** AGENT_CHANNELS: a comma list that replaces the board's project channels. */
  readonly channels: string | undefined
  readonly exe: Executables
}

/** The hq threads every prompt points at. */
export interface RoleThreads {
  readonly rulesId: string
  readonly roleId: string
}

export const renewEvery = Duration.minutes(5)
/** How long one renew may take before it counts as failed. */
export const renewTimeout = Duration.seconds(30)
/**
 * How long after the last successful renew the agent may keep running when renews fail: a minute
 * short of the 15-minute lease, so it stops before the board can hand the task to someone else.
 */
export const leaseMargin = Duration.minutes(14)

/** One line per event on stdout: time, profile, what happened. */
export const say = (profile: string, message: string) =>
  DateTime.now.pipe(Effect.flatMap((now) => Console.log(`${DateTime.formatIso(now)} ${profile} ${message}`)))

type Outcome =
  | { readonly _tag: "Exited"; readonly code: number }
  | { readonly _tag: "ClaimLost" }
  | { readonly _tag: "LeaseLost" }
const claimLost: Outcome = { _tag: "ClaimLost" }
const leaseLost: Outcome = { _tag: "LeaseLost" }

/** Runs a fresh agent on a task this profile holds, and settles it as failed if the agent exits still holding it. */
export const runTask = (config: WorkerConfig, threads: RoleThreads, task: Task) =>
  Effect.gen(function*() {
    const board = yield* Board
    const launcher = yield* Launcher
    const log = (message: string) => say(config.profile, message)
    const agent = agentFor(config.role, task.labels)
    const prompt = buildPrompt({ profile: config.profile, role: config.role, repo: config.repo, taskId: task.id, ...threads })

    /**
     * Renews every 5 minutes. A failed renew (an error or no answer in 30 s) is tried again at the next
     * 5 minutes, but no later than 14 minutes after the last success; one that fails at that point
     * means the lease may lapse before the board hears from us again.
     */
    const keepalive = Effect.gen(function*() {
      let lastSuccess = yield* Clock.currentTimeMillis
      let next = lastSuccess + Duration.toMillis(renewEvery)
      while (true) {
        yield* Effect.sleep(Duration.millis(Math.max(0, next - (yield* Clock.currentTimeMillis))))
        const result = yield* board.renew(task.id).pipe(
          Effect.as("renewed" as const),
          Effect.timeoutOrElse({
            duration: renewTimeout,
            orElse: () => Effect.fail(new BoardError({ command: "tasks renew", reason: "timeout", message: `no answer in ${Duration.format(renewTimeout)}` })),
          }),
          Effect.catch((e) =>
            e.reason === "claim_lost"
              ? Effect.succeed("lost" as const)
              : log(`renew #${task.id} failed: ${e.reason} ${e.message}`).pipe(Effect.as("failed" as const))
          ),
        )
        const now = yield* Clock.currentTimeMillis
        if (result === "lost") return claimLost
        if (result === "renewed") {
          yield* log(`renewed #${task.id}`)
          lastSuccess = now
          next = now + Duration.toMillis(renewEvery)
          continue
        }
        const deadline = lastSuccess + Duration.toMillis(leaseMargin)
        if (now >= deadline) return leaseLost
        next = Math.min(now + Duration.toMillis(renewEvery), deadline)
      }
    })

    const outcome = yield* Effect.scoped(Effect.gen(function*() {
      const child = yield* launcher.start(launchArgv(agent, prompt, config.exe), {
        cwd: config.repo,
        prefix: `[${config.profile} #${task.id}]`,
        logFile: join(config.repo, ".agent", config.profile, `${task.id}.log`),
      })
      yield* log(`started #${task.id} pid ${child.pid} (${agent.kind} ${agent.model})`)
      const exited = child.exited.pipe(Effect.map((code): Outcome => ({ _tag: "Exited", code })))
      return yield* Effect.raceFirst(exited, keepalive)
    }).pipe(
      Effect.catchTag("LaunchError", (e) =>
        log(`could not start ${e.argv0} for #${task.id}: ${e.message}`).pipe(Effect.as<Outcome>({ _tag: "Exited", code: 127 }))
      ),
    ))

    if (outcome._tag === "ClaimLost") return yield* log(`lost the claim on #${task.id}; stopped the agent`)
    if (outcome._tag === "LeaseLost") {
      // The agent is stopped (its scope closed). Hand the task back if the board still lets us; settle nothing else.
      yield* board.release(task.id).pipe(
        Effect.catch((e) => e.reason === "claim_lost" ? Effect.void : log(`release #${task.id} failed: ${e.reason} ${e.message}`)),
      )
      return yield* log(`lease lost on #${task.id}: no renew succeeded for ${Duration.format(leaseMargin)}; stopped the agent`)
    }
    yield* log(`exited #${task.id} code ${outcome.code}`)
    if (yield* board.holds(task.id)) {
      yield* board.fail(task.id, `agent exited without settling (exit ${outcome.code})`)
      yield* log(`settled #${task.id} failed`)
    } else {
      yield* log(`#${task.id} settled by the agent`)
    }
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.gen(function*() {
        const board = yield* Board
        if (yield* board.holds(task.id)) {
          yield* board.release(task.id)
          yield* say(config.profile, `released #${task.id}`)
        }
      }).pipe(Effect.catch((e) => say(config.profile, `release #${task.id} failed: ${e.reason}`)))
    ),
  )

/** Looks in each project channel in turn, one claim with a wait per channel, and runs each task it gets. */
export const round = (config: WorkerConfig, threads: RoleThreads) =>
  Effect.gen(function*() {
    const board = yield* Board
    const paths = config.channels === undefined ? yield* board.channels : []
    const channels = projectChannels(paths, config.channels)
    if (channels.length === 0) {
      yield* say(config.profile, "no project channels yet")
      return yield* Effect.sleep(Duration.seconds(config.waitSeconds))
    }
    for (const channel of channels) {
      const claimed = yield* board.claimReady(channel, config.role, `${config.waitSeconds}s`)
      if (Option.isSome(claimed)) {
        yield* say(config.profile, `claimed #${claimed.value.id} in ${claimed.value.channel}`)
        yield* runTask(config, threads, claimed.value)
      }
    }
  })

/** Forever: rounds over the project channels. A board error is logged and the loop goes on after a wait. */
export const work = (config: WorkerConfig) =>
  Effect.gen(function*() {
    const board = yield* Board
    const threads: RoleThreads = { rulesId: yield* board.roleThread("worker"), roleId: yield* board.roleThread(config.role) }
    yield* say(config.profile, `waiting for ${config.role} tasks (rules #${threads.rulesId}, role #${threads.roleId})`)
    return yield* round(config, threads).pipe(
      Effect.catch((e) =>
        say(config.profile, `error: ${e._tag} ${"reason" in e ? e.reason : ""} ${e.message}`).pipe(
          Effect.andThen(Effect.sleep(Duration.seconds(config.waitSeconds))),
        )
      ),
      Effect.forever,
    )
  })
