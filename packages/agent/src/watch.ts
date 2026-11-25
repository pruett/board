/**
 * The lead and chief-of-staff loops: wait on the board for the events a program answers, run one
 * fresh agent per event, wait again. Several waits run at once; the first event wins and the others
 * are interrupted. Each wait carries its own cursor across runs, so every event that lands while an
 * agent runs gets its own run next, in order, once. The cursors are saved to
 * `.agent/<profile>/cursors.json` after each event, so a restart goes on from where it stopped.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Duration, Effect, Option } from "effect"
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
export type Decision = "run" | "own" | "seen" | "ignored"

/**
 * The pure part of the loop: what to do with an event a trigger printed. `seen`: this cursor was
 * handled already (an event can match two triggers on one channel). Distinct cursors each get a run,
 * even on one thread: a run that started after an event is no proof it answered it.
 */
export const decide = (trigger: Trigger, event: BoardEvent, profile: string, state: Pick<WatchState, "handled">): Decision =>
  state.handled.has(event.cursor)
    ? "seen"
    : isOwn(event, profile)
    ? "own"
    : !trigger.accepts(event)
    ? "ignored"
    : "run"

/** Cursors per trigger, the events already handled, and the file the cursors are saved to (none: not saved). */
export interface WatchState {
  readonly cursors: Map<string, string | undefined>
  readonly handled: Set<string>
  readonly file: string | undefined
}

/** Where a program's cursors are saved. */
export const cursorFile = (repo: string, profile: string) => join(repo, ".agent", profile, "cursors.json")

/** The saved cursors per trigger name; empty when there is no file or it does not parse. */
export const readCursors = (file: string): Record<string, string> => {
  try {
    const json: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof json !== "object" || json === null) return {}
    return Object.fromEntries(Object.entries(json).filter((e): e is [string, string] => typeof e[1] === "string"))
  } catch {
    return {}
  }
}

/** Saves the cursors (write then rename, so a crash leaves the old file or the new one). */
export const writeCursors = (file: string, cursors: ReadonlyMap<string, string | undefined>) => {
  mkdirSync(dirname(file), { recursive: true })
  const json = Object.fromEntries([...cursors].filter((e): e is [string, string] => e[1] !== undefined))
  writeFileSync(`${file}.tmp`, `${JSON.stringify(json, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

const save = (state: WatchState) => state.file === undefined ? Effect.void : Effect.sync(() => writeCursors(state.file!, state.cursors))

/** How many handled event cursors to remember. */
const handledLimit = 1000

/**
 * Starts every trigger at its saved cursor in `file`, or at its channel's cursor now when none is
 * saved, and saves them at once so a restart before the first event still goes on from here.
 */
export const initialState = (triggers: ReadonlyArray<Trigger>, file?: string) =>
  Effect.gen(function*() {
    const board = yield* Board
    const saved = file === undefined ? {} : readCursors(file)
    const cursors = new Map<string, string | undefined>()
    for (const trigger of triggers) cursors.set(trigger.name, saved[trigger.name] ?? (yield* board.cursor(trigger.channel)))
    const state: WatchState = { cursors, handled: new Set<string>(), file }
    yield* save(state)
    return state
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
    // Another trigger on the same channel may answer what this one ignores, so only a run marks an event handled.
    if (decision === "own") yield* log(`skipped own ${what}`)
    if (decision === "ignored") yield* log(`ignored ${what}`)
    if (decision === "run") {
      state.handled.add(e.cursor)
      if (state.handled.size > handledLimit) state.handled.delete(state.handled.values().next().value!)
      yield* log(`woke on ${what}`)
      yield* runEvent(config, e)
    }
    // Saved after the run: a restart while it runs runs it again rather than losing it.
    yield* save(state)
  })

/** Forever: rounds of waits. A board error is logged and the loop goes on after a pause. */
export const watch = (config: WatchConfig) =>
  Effect.gen(function*() {
    const state = yield* initialState(config.triggers, cursorFile(config.repo, config.profile))
    yield* say(config.profile, `waiting on ${config.triggers.map((t) => t.name).join(", ")}`)
    return yield* step(config, state).pipe(
      Effect.catch((e) =>
        say(config.profile, `error: ${e._tag} ${e.reason} ${e.message}`).pipe(Effect.andThen(Effect.sleep(Duration.seconds(10))))
      ),
      Effect.forever,
    )
  })
