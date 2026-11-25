import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
const fakeBoard = (options: {
  channels: Array<string>
  ready?: Record<string, Array<Task>>
  renewFails?: string
  /** Overrides renew: the nth call's answer (0-based). */
  renew?: (n: number) => Effect.Effect<void, BoardError>
}) => {
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
        if (options.renew !== undefined) return options.renew(calls.filter((c) => c.startsWith("renew")).length - 1)
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

  test("a renew with no answer times out at 30 s; failing until 14 m after the last success stops the agent and releases", async () => {
    const { board, calls, held } = fakeBoard({ channels: [], renew: () => Effect.never })
    held.add(task.id)
    let killed = false
    await run(
      Layer.succeed(Board, board),
      Effect.gen(function*() {
        const exit = yield* Deferred.make<number>()
        const fake = fakeLauncher(exit)
        const fiber = yield* runTask(config, threads, task).pipe(Effect.provideService(Launcher, fake.launcher), Effect.forkChild)
        // Tries at 5:00 and 10:30 (each times out 30 s later), then at 14:00, the last chance.
        yield* TestClock.adjust("14 minutes")
        expect(calls).toEqual(["renew 9", "renew 9", "renew 9"])
        expect(fake.killed()).toBe(false)
        yield* TestClock.adjust("29 seconds")
        expect(fake.killed()).toBe(false)
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(fiber)
        killed = fake.killed()
      }),
    )
    expect(killed).toBe(true)
    expect(calls).toEqual(["renew 9", "renew 9", "renew 9", "release 9"])
    expect(held.has(task.id)).toBe(false)
  })

  test("a renew that succeeds after failures moves the 14 m deadline", async () => {
    const unavailable = Effect.fail(new BoardError({ command: "tasks renew", reason: "http_error", message: "503" }))
    // 5:00 fails, 10:00 succeeds, 15:00 and 20:00 fail, 24:00 fails: stop there (14 m after 10:00).
    const { board, calls, held } = fakeBoard({ channels: [], renew: (n) => n === 1 ? Effect.void : unavailable })
    held.add(task.id)
    await run(
      Layer.succeed(Board, board),
      Effect.gen(function*() {
        const exit = yield* Deferred.make<number>()
        const fake = fakeLauncher(exit)
        const fiber = yield* runTask(config, threads, task).pipe(Effect.provideService(Launcher, fake.launcher), Effect.forkChild)
        yield* TestClock.adjust("23 minutes")
        expect(fake.killed()).toBe(false)
        expect(calls.length).toBe(4)
        yield* TestClock.adjust("1 minute")
        yield* Fiber.join(fiber)
        expect(fake.killed()).toBe(true)
      }),
    )
    expect(calls).toEqual(["renew 9", "renew 9", "renew 9", "renew 9", "renew 9", "release 9"])
  })

  test("a lease lost on a task already taken from us settles nothing", async () => {
    const { board, calls, held } = fakeBoard({ channels: [], renew: () => Effect.fail(new BoardError({ command: "tasks renew", reason: "http_error", message: "" })) })
    held.add(task.id)
    const taken = Board.of({ ...board, release: (id) => Effect.sync(() => calls.push(`release ${id}`)).pipe(Effect.andThen(Effect.fail(new BoardError({ command: "tasks release", reason: "claim_lost", message: "" })))) })
    await run(
      Layer.succeed(Board, taken),
      Effect.gen(function*() {
        const exit = yield* Deferred.make<number>()
        const fake = fakeLauncher(exit)
        const fiber = yield* runTask(config, threads, task).pipe(Effect.provideService(Launcher, fake.launcher), Effect.forkChild)
        yield* TestClock.adjust("14 minutes")
        yield* Fiber.join(fiber)
      }),
    )
    expect(calls.filter((c) => !c.startsWith("renew"))).toEqual(["release 9"])
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

describe("launcher", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  test("stopping the agent kills its process group, a descendant holding its pipes included, within the grace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-launcher-"))
    const pids = join(dir, "pids.json")
    // The agent starts a descendant that inherits stdout/stderr, then waits; both ignore nothing.
    const script = `const d = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" })
await Bun.write(${JSON.stringify(pids)}, JSON.stringify({ parent: process.pid, descendant: d.pid }))
process.on("SIGTERM", () => process.exit(0))
setInterval(() => {}, 1000)`
    let seen: { parent: number; descendant: number } | undefined
    try {
      const started = Date.now()
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const launcher = yield* Launcher
        yield* launcher.start([process.execPath, "-e", script], { cwd: dir, prefix: "[t]", logFile: join(dir, "out.log") })
        for (let i = 0; i < 200 && seen === undefined; i++) {
          const text = yield* Effect.promise(() => Bun.file(pids).text().catch(() => ""))
          if (text !== "") seen = JSON.parse(text)
          else yield* Effect.promise(() => Bun.sleep(20))
        }
      })).pipe(Effect.provide(Launcher.layer)))
      expect(seen).toBeDefined()
      expect(Date.now() - started).toBeLessThan(10_000)
      await Bun.sleep(100)
      expect(alive(seen!.parent)).toBe(false)
      expect(alive(seen!.descendant)).toBe(false)
    } finally {
      if (seen) for (const pid of [seen.parent, seen.descendant]) try { process.kill(pid, "SIGKILL") } catch {}
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("exit is reported once the agent exits, though a descendant keeps its pipes open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-launcher-"))
    const pidFile = join(dir, "descendant")
    const script = `const d = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" })
await Bun.write(${JSON.stringify(pidFile)}, String(d.pid))
console.log("bye")
process.exit(7)`
    let descendant = 0
    try {
      const started = Date.now()
      const code = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const launcher = yield* Launcher
        const child = yield* launcher.start([process.execPath, "-e", script], { cwd: dir, prefix: "[t]", logFile: join(dir, "out.log") })
        return yield* child.exited
      })).pipe(Effect.provide(Launcher.layer)))
      descendant = Number(await Bun.file(pidFile).text())
      expect(code).toBe(7)
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(await Bun.file(join(dir, "out.log")).text()).toContain("bye")
      await Bun.sleep(100)
      expect(alive(descendant)).toBe(false)
    } finally {
      if (descendant > 0) try { process.kill(descendant, "SIGKILL") } catch {}
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
