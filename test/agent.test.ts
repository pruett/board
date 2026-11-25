import { describe, expect, test } from "bun:test"
import { Console, Deferred, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import {
  agentFor,
  Board,
  BoardError,
  buildPrompt,
  type Child,
  Launcher,
  launchArgv,
  projectChannels,
  round,
  runTask,
  type Task,
  type WorkerConfig,
} from "@board/agent"

const config: WorkerConfig = {
  role: "implementer",
  profile: "implementer-test",
  repo: "/repo",
  waitSeconds: 60,
  channels: undefined,
  exe: { claude: "claude", codex: "codex" },
}
const threads = { rulesId: "422", roleId: "425" }

describe("agent choice", () => {
  test("each role has its agent", () => {
    expect(agentFor("implementer", {})).toEqual({ kind: "claude", model: "claude-opus-5-5" })
    expect(agentFor("researcher", {})).toEqual({ kind: "claude", model: "claude-haiku-5-5" })
    expect(agentFor("reviewer", {})).toEqual({ kind: "codex", model: "gpt-6.1-sol" })
  })
  test("a researcher on a design task gets the stronger model", () => {
    expect(agentFor("researcher", { type: "design" })).toEqual({ kind: "claude", model: "claude-fable-5-1" })
    expect(agentFor("implementer", { type: "design" }).model).toBe("claude-opus-5-5")
  })
  test("argv keeps the prompt as one item", () => {
    const prompt = "say $HOME `x` \"q\""
    expect(launchArgv({ kind: "claude", model: "m" }, prompt, { claude: "/bin/c", codex: "x" })).toEqual(
      ["/bin/c", "--model", "m", "--permission-mode", "auto", "--output-format", "stream-json", "--verbose", "-p", prompt],
    )
    expect(launchArgv({ kind: "codex", model: "g" }, prompt, { claude: "c", codex: "/bin/x" })).toEqual(
      ["/bin/x", "exec", "-m", "g", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", prompt],
    )
  })
})

describe("prompt", () => {
  test("names the profile, the task, and the threads to read", () => {
    expect(buildPrompt({ profile: "implementer-mac", role: "implementer", repo: "/r", taskId: "7", rulesId: "422", roleId: "425" })).toBe(
      "You are implementer-mac, a implementer. Board writes: bun run --cwd /r vb <command> --as implementer-mac. " +
        "You already hold task #7 (claimed for you; renew it with vb tasks renew 7 --as implementer-mac before each 15 min lease ends). " +
        "Read #422 (the rules every worker follows), #425 (your role), then vb read 7 and its whole thread. " +
        "Follow the brief. Finish with vb tasks complete or vb tasks fail, then exit.",
    )
  })
})

describe("channels", () => {
  test("top-level channels but hq, as prefixes, once each", () => {
    expect(projectChannels(["hq", "fleet2", "fleet2/sub", "alpha", "hq/x"])).toEqual(["alpha/", "fleet2/"])
  })
  test("AGENT_CHANNELS replaces the list", () => {
    expect(projectChannels(["fleet2"], " a, b/ ,")).toEqual(["a", "b/"])
    expect(projectChannels(["fleet2"], "")).toEqual(["fleet2/"])
  })
})

/** A board in memory: records every call, hands out queued tasks per channel, and says who holds what. */
const fakeBoard = (options: { channels: Array<string>; ready?: Record<string, Array<Task>>; renewFails?: string }) => {
  const calls: Array<string> = []
  const held = new Set<string>()
  const board = Board.of({
    channels: Effect.sync(() => {
      calls.push("channels")
      return options.channels
    }),
    roleThread: (role) => Effect.succeed(role === "worker" ? "422" : "425"),
    claimReady: (channel, role, wait) =>
      Effect.sync(() => {
        calls.push(`claim ${channel} ${role} ${wait}`)
        const task = options.ready?.[channel]?.shift()
        if (task === undefined) return Option.none()
        held.add(task.id)
        return Option.some(task)
      }),
    renew: (id) =>
      Effect.suspend(() => {
        calls.push(`renew ${id}`)
        return options.renewFails === undefined
          ? Effect.void
          : Effect.fail(new BoardError({ command: "tasks renew", reason: options.renewFails, message: "" }))
      }),
    holds: (id) => Effect.sync(() => held.has(id)),
    fail: (id, reason) =>
      Effect.sync(() => {
        calls.push(`fail ${id} ${reason}`)
        held.delete(id)
      }),
    release: (id) =>
      Effect.sync(() => {
        calls.push(`release ${id}`)
        held.delete(id)
      }),
  })
  return { board, calls, held }
}

/** A launcher whose child exits when the test says so; records the argv and whether it was killed. */
const fakeLauncher = (exit: Deferred.Deferred<number>) => {
  const started: Array<ReadonlyArray<string>> = []
  let killed = false
  const launcher = Launcher.of({
    start: (argv) =>
      Effect.acquireRelease(
        Effect.sync((): Child => {
          started.push(argv)
          return { pid: 42, exited: Deferred.await(exit) }
        }),
        () => Effect.sync(() => { killed = Deferred.isDoneUnsafe(exit) ? killed : true }),
      ),
  })
  return { launcher, started, killed: () => killed }
}

const task: Task = { id: "9", channel: "fleet2", labels: { role: "implementer" } }

/** Runs `body` on a TestClock with the event log silenced. */
const quiet = { ...console, log: () => {} } as unknown as Console.Console
const run = <A, E>(layer: Layer.Layer<Board>, body: Effect.Effect<A, E, Board>) =>
  Effect.runPromise(body.pipe(Effect.provide(Layer.merge(layer, TestClock.layer())), Effect.provideService(Console.Console, quiet)))

describe("keepalive and settle", () => {
  test("renews every 5 minutes while the agent runs, and fails the task it left claimed", async () => {
    const { board, calls, held } = fakeBoard({ channels: [] })
    held.add(task.id)
    await run(
      Layer.succeed(Board, board),
      Effect.gen(function*() {
        const exit = yield* Deferred.make<number>()
        const { launcher, started } = fakeLauncher(exit)
        const fiber = yield* runTask(config, threads, task).pipe(Effect.provideService(Launcher, launcher), Effect.forkChild)
        yield* TestClock.adjust("4 minutes")
        expect(calls.filter((c) => c.startsWith("renew"))).toEqual([])
        yield* TestClock.adjust("1 minute")
        yield* TestClock.adjust("5 minutes")
        expect(calls.filter((c) => c.startsWith("renew"))).toEqual(["renew 9", "renew 9"])
        expect(started[0]?.at(-1)).toContain("task #9")
        yield* Deferred.succeed(exit, 3)
        yield* Fiber.join(fiber)
      }),
    )
    expect(calls.at(-1)).toBe("fail 9 agent exited without settling (exit 3)")
    expect(held.has(task.id)).toBe(false)
  })

  test("leaves a task the agent settled alone", async () => {
    const { board, calls, held } = fakeBoard({ channels: [] })
    held.add(task.id)
    await run(
      Layer.succeed(Board, board),
      Effect.gen(function*() {
        const exit = yield* Deferred.make<number>()
        const { launcher } = fakeLauncher(exit)
        const fiber = yield* runTask(config, threads, task).pipe(Effect.provideService(Launcher, launcher), Effect.forkChild)
        yield* Effect.yieldNow
        held.delete(task.id)
        yield* Deferred.succeed(exit, 0)
        yield* Fiber.join(fiber)
      }),
    )
    expect(calls.filter((c) => c.startsWith("fail") || c.startsWith("release"))).toEqual([])
  })

  test("stops the agent when the claim is lost, and settles nothing", async () => {
    const { board, calls, held } = fakeBoard({ channels: [], renewFails: "claim_lost" })
    held.add(task.id)
    let killed = false
    await run(
      Layer.succeed(Board, board),
      Effect.gen(function*() {
        const exit = yield* Deferred.make<number>()
        const fake = fakeLauncher(exit)
        const fiber = yield* runTask(config, threads, task).pipe(Effect.provideService(Launcher, fake.launcher), Effect.forkChild)
        yield* TestClock.adjust("5 minutes")
        yield* Fiber.join(fiber)
        killed = fake.killed()
      }),
    )
    expect(killed).toBe(true)
    expect(calls).toEqual(["renew 9"])
  })

  test("an interrupt kills the agent and releases the claim", async () => {
    const { board, calls, held } = fakeBoard({ channels: [] })
    held.add(task.id)
    let killed = false
    await run(
      Layer.succeed(Board, board),
      Effect.gen(function*() {
        const exit = yield* Deferred.make<number>()
        const fake = fakeLauncher(exit)
        const fiber = yield* runTask(config, threads, task).pipe(Effect.provideService(Launcher, fake.launcher), Effect.forkChild)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        killed = fake.killed()
      }),
    )
    expect(killed).toBe(true)
    expect(calls).toEqual(["release 9"])
  })
})

describe("channel rotation", () => {
  test("one claim per channel per round, in order, running each task it gets", async () => {
    const other: Task = { id: "11", channel: "beta/x", labels: {} }
    const { board, calls } = fakeBoard({ channels: ["hq", "alpha", "beta", "beta/x"], ready: { "beta/": [other] } })
    await run(
      Layer.succeed(Board, board),
      Effect.gen(function*() {
        const exit = yield* Deferred.make<number>()
        yield* Deferred.succeed(exit, 1)
        const { launcher, started } = fakeLauncher(exit)
        yield* round(config, threads).pipe(Effect.provideService(Launcher, launcher))
        expect(started.length).toBe(1)
      }),
    )
    expect(calls).toEqual([
      "channels",
      "claim alpha/ implementer 60s",
      "claim beta/ implementer 60s",
      "fail 11 agent exited without settling (exit 1)",
    ])
  })

  test("AGENT_CHANNELS skips the channel list", async () => {
    const { board, calls } = fakeBoard({ channels: ["alpha"] })
    await run(
      Layer.succeed(Board, board),
      round({ ...config, channels: "fleet2,zeta/" }, threads).pipe(Effect.provideService(Launcher, fakeLauncher(Deferred.makeUnsafe()).launcher)),
    )
    expect(calls).toEqual(["claim fleet2 implementer 60s", "claim zeta/ implementer 60s"])
  })
})
