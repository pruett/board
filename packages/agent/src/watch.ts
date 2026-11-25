/**
 * The lead and chief-of-staff loops: wait on the board for the events a program answers, run one
 * fresh agent per event, wait again. Several waits run at once; the first event wins and the others
 * are interrupted. Each wait carries its own cursor across runs, so an event that lands while an
 * agent runs is handled next, once.
 */
import { join } from "node:path"
import { Clock, Duration, Effect, Option } from "effect"
import { Board, type BoardEvent } from "./Board.ts"
import { Launcher } from "./Launcher.ts"
import { type Executables, launchArgv } from "./roles.ts"
import { say } from "./worker.ts"

/** One thing a program waits for: a `vb wait` on a channel with filters, and which of its events start a run. */
export interface Trigger {
  readonly name: string
  readonly channel: string
  /** `vb wait` filter flags, e.g. `["--label", "goal=fleet2"]`. */
  readonly filters: ReadonlyArray<string>
  /** Whether an event the wait printed is one this program answers (labels also match replies in a thread). */
  readonly accepts: (event: BoardEvent) => boolean
}

export interface WatchConfig {
  readonly profile: string
  readonly model: string
  /** The repo root: the agent's cwd and where `.agent/` logs go. */
  readonly repo: string
  readonly triggers: ReadonlyArray<Trigger>
  /** The whole prompt for one event. */
  readonly prompt: (event: BoardEvent) => string
  /** How long one round of waits lasts before they start again. */
  readonly waitSeconds: number
  readonly exe: Executables
}

/** Whether `profile` caused the event: its own writes never wake it. */
export const isOwn = (event: BoardEvent, profile: string) => event.actor.endsWith(`+${profile}`)

const taskEvents = (types: ReadonlyArray<string>) => (event: BoardEvent) => types.includes(event.type)

/** A lead's triggers: a task in its channel completed, blocked or failed; a goal for it in hq (and replies on it). */
export const leadTriggers = (project: string): Array<Trigger> => [
  {
    name: project,
    channel: project,
    filters: ["--label", "board.task=completed|blocked|failed"],
    accepts: taskEvents(["task.completed", "task.blocked", "task.failed"]),
  },
  {
    name: `hq goal=${project}`,
    channel: "hq",
    filters: ["--label", `goal=${project}`],
    accepts: (e) => e.type === "task.created" || (e.type === "message.posted" && e.re !== null),
  },
]

/** k2's triggers: a lead's question in hq (a task labeled ask=…, or a reply on one), and anything the owner posts in hq. */
export const k2Triggers = (owner: string): Array<Trigger> => [
  {
    name: "hq ask",
    channel: "hq",
    filters: ["--label", "ask"],
    accepts: (e) => e.type === "task.created" || e.type === "task.blocked" || (e.type === "message.posted" && e.re !== null),
  },
  {
    name: `hq by ${owner}`,
    channel: "hq",
    filters: ["--by", owner],
    // `--by` matches the person's agent profiles too (one token): only the person's own posts count.
    accepts: (e) => e.type === "message.posted" && e.actorKind === "person" && e.actorHandle === owner,
  },
]

/** What the loop does with one event: run an agent on it, or why not. */
export type Decision = "run" | "own" | "seen" | "covered" | "ignored"

/** The thread an event is about: its root. */
const threadOf = (event: BoardEvent) => event.re ?? event.messageId

/**
 * The pure part of the loop: what to do with an event a trigger printed. `seen`: handled already (an
 * event can match two triggers on one channel). `covered`: a run on its thread started after it
 * happened, so that run read it (a lead's ask is often a create then a block, a second apart).
 */
export const decide = (trigger: Trigger, event: BoardEvent, profile: string, state: Pick<WatchState, "handled" | "runs">): Decision =>
  state.handled.has(event.cursor)
    ? "seen"
    : isOwn(event, profile)
    ? "own"
    : !trigger.accepts(event)
    ? "ignored"
    : (state.runs.get(threadOf(event)) ?? -Infinity) > event.at
    ? "covered"
    : "run"

/** Cursors per trigger, the events already handled, and when the last run on each thread started. */
export interface WatchState {
  readonly cursors: Map<string, string | undefined>
  readonly handled: Set<string>
  readonly runs: Map<string, number>
}

/** How many handled event cursors to remember. */
const handledLimit = 1000

/** Starts every trigger at its channel's cursor now. */
export const initialState = (triggers: ReadonlyArray<Trigger>) =>
  Effect.gen(function*() {
    const board = yield* Board
    const cursors = new Map<string, string | undefined>()
    for (const trigger of triggers) cursors.set(trigger.name, yield* board.cursor(trigger.channel))
    return { cursors, handled: new Set<string>(), runs: new Map<string, number>() } satisfies WatchState
  })

/** Runs one fresh agent on one event and waits for it to exit. */
export const runEvent = (config: WatchConfig, event: BoardEvent) =>
  Effect.gen(function*() {
    const launcher = yield* Launcher
    const log = (message: string) => say(config.profile, message)
    const code = yield* Effect.scoped(Effect.gen(function*() {
      const child = yield* launcher.start(launchArgv({ kind: "claude", model: config.model }, config.prompt(event), config.exe), {
        cwd: config.repo,
        prefix: `[${config.profile} #${event.messageId}]`,
        logFile: join(config.repo, ".agent", config.profile, `${event.cursor}-${event.messageId}.log`),
      })
      yield* log(`started on #${event.messageId} pid ${child.pid} (claude ${config.model})`)
      return yield* child.exited
    })).pipe(
      Effect.catchTag("LaunchError", (e) => log(`could not start ${e.argv0}: ${e.message}`).pipe(Effect.as(127))),
    )
    yield* log(`exited #${event.messageId} code ${code}`)
  })

/** One round: every trigger's wait at once, the first event wins; then run on it, or skip it, and move its cursor. */
export const step = (config: WatchConfig, state: WatchState) =>
  Effect.gen(function*() {
    const board = yield* Board
    const log = (message: string) => say(config.profile, message)
    const waits = config.triggers.map((trigger) =>
      board.wait(trigger.channel, trigger.filters, state.cursors.get(trigger.name), `${config.waitSeconds}s`).pipe(
        Effect.map((event) => ({ trigger, event })),
      )
    )
    const { trigger, event } = yield* Effect.raceAllFirst(waits)
    if (Option.isNone(event)) return
    const e = event.value
    state.cursors.set(trigger.name, e.cursor)
    const decision = decide(trigger, e, config.profile, state)
    const what = `${e.type} #${e.messageId} (${trigger.name}, cursor ${e.cursor})`
    if (decision === "seen") return
    // Another trigger on the same channel may answer what this one ignores, so only a run marks an event handled.
    if (decision === "own") return yield* log(`skipped own ${what}`)
    if (decision === "ignored") return yield* log(`ignored ${what}`)
    if (decision === "covered") return yield* log(`skipped ${what}: a run on #${threadOf(e)} started after it`)
    state.handled.add(e.cursor)
    if (state.handled.size > handledLimit) state.handled.delete(state.handled.values().next().value!)
    yield* log(`woke on ${what}`)
    state.runs.delete(threadOf(e))
    state.runs.set(threadOf(e), yield* Clock.currentTimeMillis)
    if (state.runs.size > handledLimit) state.runs.delete(state.runs.keys().next().value!)
    yield* runEvent(config, e)
  })

/** Forever: rounds of waits. A board error is logged and the loop goes on after a pause. */
export const watch = (config: WatchConfig) =>
  Effect.gen(function*() {
    const state = yield* initialState(config.triggers)
    yield* say(config.profile, `waiting on ${config.triggers.map((t) => t.name).join(", ")}`)
    return yield* step(config, state).pipe(
      Effect.catch((e) =>
        say(config.profile, `error: ${e._tag} ${e.reason} ${e.message}`).pipe(Effect.andThen(Effect.sleep(Duration.seconds(10))))
      ),
      Effect.forever,
    )
  })
