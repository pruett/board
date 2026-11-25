import { describe, expect, test } from "bun:test"
import { Console, Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import {
  Board,
  type BoardEvent,
  type Child,
  decide,
  initialState,
  k2Program,
  k2Prompt,
  k2Triggers,
  Launcher,
  leadProgram,
  leadPrompt,
  leadTriggers,
  step,
  type WatchConfig,
} from "@board/agent"

const ev = (cursor: string, type: string, actor: string, messageId: string, re: string | null = null, at = 0): BoardEvent => ({
  cursor,
  type,
  actor: `token:user:pruett+${actor}`,
  actorKind: "agent",
  actorHandle: `pruett/${actor}`,
  messageId,
  re,
  at,
})
const byPerson = (cursor: string, type: string, messageId: string, re: string | null = null, at = 0): BoardEvent => ({
  cursor,
  type,
  actor: "token:user:pruett",
  actorKind: "person",
  actorHandle: "pruett",
  messageId,
  re,
  at,
})

const [project, goal] = leadTriggers("fleet2")
const [ask, owner] = k2Triggers("pruett")

describe("trigger selection", () => {
  test("a lead waits on its channel's settled tasks and on hq goals for it", () => {
    expect(project).toMatchObject({ channel: "fleet2", filters: ["--label", "board.task=completed|blocked|failed"] })
    expect(goal).toMatchObject({ channel: "hq", filters: ["--label", "goal=fleet2"] })
  })
  test("the project trigger answers task events, not replies in a settled task's thread", () => {
    for (const type of ["task.completed", "task.blocked", "task.failed"]) expect(project!.accepts(ev("1", type, "w", "8"))).toBe(true)
    expect(project!.accepts(ev("1", "message.posted", "w", "9", "8"))).toBe(false)
    expect(project!.accepts(ev("1", "task.unblocked", "w", "8"))).toBe(false)
  })
  test("the goal trigger answers a new goal task and replies on it, once per task (not its root post too)", () => {
    expect(goal!.accepts(byPerson("2", "task.created", "19"))).toBe(true)
    expect(goal!.accepts(byPerson("1", "message.posted", "19"))).toBe(false)
    expect(goal!.accepts(byPerson("3", "message.posted", "20", "19"))).toBe(true)
  })
  test("k2 answers a lead's question and anything the owner posts in hq", () => {
    expect(ask).toMatchObject({ channel: "hq", filters: ["--label", "ask"] })
    expect(owner).toMatchObject({ channel: "hq", filters: ["--by", "pruett"] })
    expect(ask!.accepts(ev("2", "task.created", "lead-fleet2", "30"))).toBe(true)
    expect(ask!.accepts(ev("5", "task.blocked", "lead-fleet2", "30"))).toBe(true)
    expect(ask!.accepts(ev("6", "message.posted", "lead-fleet2", "31", "30"))).toBe(true)
    expect(owner!.accepts(byPerson("7", "message.posted", "40"))).toBe(true)
    expect(owner!.accepts(byPerson("8", "task.created", "40"))).toBe(false)
    // `--by pruett` also matches pruett's agent profiles: those are not the owner.
    expect(owner!.accepts(ev("9", "message.posted", "lead-fleet2", "41"))).toBe(false)
  })
})

describe("self-filtering", () => {
  test("a program's own writes never start a run; a worker's block of the lead's task does", () => {
    const none = { handled: new Set<string>(), runs: new Map<string, number>() }
    expect(decide(project!, ev("1", "task.completed", "lead-fleet2", "8"), "lead-fleet2", none)).toBe("own")
    expect(decide(project!, ev("2", "task.blocked", "implementer-mac", "8"), "lead-fleet2", none)).toBe("run")
    expect(decide(project!, ev("3", "task.blocked", "lead-fleet22", "8"), "lead-fleet2", none)).toBe("run")
    expect(decide(ask!, ev("4", "message.posted", "k2", "31", "30"), "k2", none)).toBe("own")
    expect(decide(ask!, ev("4", "task.blocked", "lead-fleet2", "30"), "k2", { ...none, handled: new Set(["4"]) })).toBe("seen")
  })
  test("an event a later run on its thread already saw is covered; one after the run started is not", () => {
    const state = { handled: new Set<string>(), runs: new Map([["30", 1_000]]) }
    expect(decide(ask!, ev("5", "task.blocked", "lead-fleet2", "30", null, 900), "k2", state)).toBe("covered")
    expect(decide(ask!, ev("6", "message.posted", "lead-fleet2", "31", "30", 900), "k2", state)).toBe("covered")
    expect(decide(ask!, ev("7", "message.posted", "lead-fleet2", "32", "30", 1_100), "k2", state)).toBe("run")
    expect(decide(ask!, ev("8", "task.blocked", "lead-fleet2", "40", null, 900), "k2", state)).toBe("run")
  })
})

describe("prompts", () => {
  test("lead", () => {
    expect(leadPrompt({ project: "fleet2", repo: "/r", orgId: "1", roleId: "2", contextId: "3", eventId: "8" })).toBe(
      "You are lead-fleet2, the project lead. Board writes: bun run --cwd /r vb <command> --as lead-fleet2. " +
        "Read #1 (how the organization runs), #2 (your role), #3 (your project's context: keep it current), then the event: vb read 8. " +
        "Take ONE turn: blocked -> answer in the thread and vb tasks unblock; completed or failed -> read the result, land or re-plan per the context thread; " +
        "a goal -> claim it and reply with your plan as tasks in fleet2. Then exit.",
    )
  })
  test("k2", () => {
    expect(k2Prompt({ repo: "/r", orgId: "1", owner: "pruett", eventId: "30" })).toBe(
      "You are k2, chief of staff. Board writes: bun run --cwd /r vb <command> --as k2. Read #1, then the event: vb read 30. " +
        "Answer the lead in its thread (then vb tasks unblock) or act on pruett's message. One turn, then exit.",
    )
  })
})

/**
 * A board in memory. Each `channel filters` key has a list of events in cursor order; a wait gets the
 * first one after its cursor, or never returns (so the race goes to another trigger). Records every wait.
 */
const fakeBoard = (events: Record<string, Array<BoardEvent>>, cursors: Record<string, string> = {}) => {
  const waits: Array<string> = []
  const board = Board.of({
    channels: Effect.succeed([]),
    roleThread: (role) => Effect.succeed(role === "lead" ? "5" : "4"),
    threadByLabel: (channel, labels) => Effect.succeed(channel === "hq" && labels[0] === "kind=org" ? "2" : "7"),
    cursor: (channel) => Effect.succeed(cursors[channel]),
    wait: (channel, filters, after) => {
      const key = `${channel} ${filters.join(" ")}`
      waits.push(`${key} after ${after}`)
      const next = (events[key] ?? []).find((e) => Number(e.cursor) > Number(after ?? 0))
      return next === undefined ? Effect.never : Effect.succeed(Option.some(next))
    },
    claimReady: () => Effect.succeed(Option.none()),
    renew: () => Effect.void,
    holds: () => Effect.succeed(false),
    fail: () => Effect.void,
    release: () => Effect.void,
  })
  return { board, waits }
}

/** A launcher whose child exits at once; records each prompt. */
const fakeLauncher = () => {
  const prompts: Array<string> = []
  const launcher = Launcher.of({
    start: (argv) =>
      Effect.sync((): Child => {
        prompts.push(argv.at(-1) ?? "")
        return { pid: 1, exited: Effect.succeed(0) }
      }),
  })
  return { launcher, prompts }
}

const lines: Array<string> = []
const capture = { ...console, log: (line: string) => lines.push(line) } as unknown as Console.Console
const run = <A, E>(board: Board["Service"], launcher: Launcher["Service"], body: Effect.Effect<A, E, Board | Launcher>) => {
  lines.length = 0
  return Effect.runPromise(body.pipe(
    Effect.provide(Layer.mergeAll(Layer.succeed(Board, board), Layer.succeed(Launcher, launcher), TestClock.layer())),
    Effect.provideService(Console.Console, capture),
  ))
}
const options = { repo: "/repo", waitSeconds: 600, exe: { claude: "claude", codex: "codex" } }
const PROJECT = "fleet2 --label board.task=completed|blocked|failed"
const GOAL = "hq --label goal=fleet2"

describe("lead loop", () => {
  test("starts each trigger at its channel's cursor, and carries each cursor to the next wait", async () => {
    const { board, waits } = fakeBoard({
      [PROJECT]: [ev("13", "task.blocked", "implementer-test", "8"), ev("15", "task.blocked", "implementer-test", "9")],
    }, { fleet2: "7", hq: "5" })
    const { launcher, prompts } = fakeLauncher()
    await run(board, launcher, Effect.gen(function*() {
      const config: WatchConfig = yield* leadProgram("fleet2", options)
      const state = yield* initialState(config.triggers)
      yield* step(config, state)
      yield* step(config, state)
      expect(state.cursors.get("fleet2")).toBe("15")
      expect(state.cursors.get("hq goal=fleet2")).toBe("5")
    }))
    expect(waits).toEqual([`${PROJECT} after 7`, `${GOAL} after 5`, `${PROJECT} after 13`, `${GOAL} after 5`])
    expect(prompts.map((p) => p.match(/vb read (\d+)\./)?.[1])).toEqual(["8", "9"])
    expect(prompts[0]).toContain("Read #2 (how the organization runs), #5 (your role), #7 (your project's context")
  })

  test("skips its own completes and logs it, then wakes on the next worker event", async () => {
    const { board } = fakeBoard({
      [PROJECT]: [ev("20", "task.completed", "lead-fleet2", "8"), ev("22", "task.failed", "implementer-test", "9")],
    })
    const { launcher, prompts } = fakeLauncher()
    await run(board, launcher, Effect.gen(function*() {
      const config = yield* leadProgram("fleet2", options)
      const state = yield* initialState(config.triggers)
      yield* step(config, state)
      yield* step(config, state)
    }))
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain("vb read 9.")
    expect(lines.map((l) => l.split(" ").slice(1).join(" "))).toEqual([
      "lead-fleet2 skipped own task.completed #8 (fleet2, cursor 20)",
      "lead-fleet2 woke on task.failed #9 (fleet2, cursor 22)",
      "lead-fleet2 started on #9 pid 1 (claude claude-fable-5-1)",
      "lead-fleet2 exited #9 code 0",
    ])
  })

  test("a goal in hq wakes it; the replies in a settled task's thread do not", async () => {
    const { board } = fakeBoard({
      [PROJECT]: [ev("30", "message.posted", "implementer-test", "31", "8")],
      [GOAL]: [byPerson("40", "task.created", "39")],
    })
    const { launcher, prompts } = fakeLauncher()
    await run(board, launcher, Effect.gen(function*() {
      const config = yield* leadProgram("fleet2", options)
      const state = yield* initialState(config.triggers)
      yield* step(config, state)
      yield* step(config, state)
    }))
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain("vb read 39.")
    expect(lines.some((l) => l.includes("ignored message.posted #31"))).toBe(true)
  })
})

describe("k2 loop", () => {
  test("an event one trigger ignores still runs through the other", async () => {
    // A lead's ask: `--by pruett` sees it first (same token) and ignores it; the ask trigger must still run it.
    const created = ev("70", "task.created", "lead-fleet2", "69", null, 1)
    const events: Record<string, Array<BoardEvent>> = { "hq --by pruett": [created], "hq --label ask": [] }
    const { board } = fakeBoard(events)
    const { launcher, prompts } = fakeLauncher()
    await run(board, launcher, Effect.gen(function*() {
      const config = yield* k2Program("pruett", options)
      const state = yield* initialState(config.triggers)
      yield* step(config, state)
      events["hq --label ask"]!.push(created)
      yield* step(config, state)
    }))
    expect(prompts.map((p) => p.match(/vb read (\d+)\./)?.[1])).toEqual(["69"])
    expect(lines.some((l) => l.includes("ignored task.created #69 (hq by pruett, cursor 70)"))).toBe(true)
  })

  test("a lead's create then block before k2 runs is one run; a reply during the run is the next", async () => {
    // TestClock starts at 0 and does not move: the run starts at 0, so events at -1 happened before it.
    const { board } = fakeBoard({
      "hq --label ask": [
        ev("60", "task.created", "lead-fleet2", "59", null, -1),
        ev("61", "task.blocked", "lead-fleet2", "59", null, -1),
        ev("63", "message.posted", "lead-fleet2", "62", "59", 1),
      ],
    })
    const { launcher, prompts } = fakeLauncher()
    await run(board, launcher, Effect.gen(function*() {
      const config = yield* k2Program("pruett", options)
      const state = yield* initialState(config.triggers)
      for (let i = 0; i < 3; i++) yield* step(config, state)
    }))
    expect(prompts.map((p) => p.match(/vb read (\d+)\./)?.[1])).toEqual(["59", "62"])
    expect(lines.some((l) => l.includes("skipped task.blocked #59 (hq ask, cursor 61): a run on #59 started after it"))).toBe(true)
  })

  test("an event both triggers match runs once", async () => {
    const reply = byPerson("50", "message.posted", "51", "30")
    const { board, waits } = fakeBoard({ "hq --label ask": [reply], "hq --by pruett": [reply] }, { hq: "45" })
    const { launcher, prompts } = fakeLauncher()
    await run(board, launcher, Effect.gen(function*() {
      const config = yield* k2Program("pruett", options)
      const state = yield* initialState(config.triggers)
      yield* step(config, state)
      yield* step(config, state)
      expect(state.cursors.get("hq ask")).toBe("50")
      expect(state.cursors.get("hq by pruett")).toBe("50")
    }))
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain("You are k2, chief of staff.")
    expect(waits).toEqual(["hq --label ask after 45", "hq --by pruett after 45", "hq --label ask after 50", "hq --by pruett after 45"])
  })
})
