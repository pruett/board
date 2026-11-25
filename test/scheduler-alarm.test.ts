import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { board } from "@vercel/board"
import { a2, a2SqliteStore, memoryBlob, sqlTables, type DrainableServer } from "@board/internals"
import { boardDb, registerDriver, type SqlDriver } from "@board/sql"
import { nodeSqlDriver } from "@board/sql-node"
import { Alarm, alarmScheduler, makeAlarmScheduler } from "@board/scheduler-alarm"

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

/** A stored alarm, like a Durable Object's: one time, kept across "restarts". */
function fakeAlarm() {
  let at: number | null = null
  const alarm: Alarm["Service"] = { get: async () => at, set: async (t) => { at = t } }
  return { alarm, at: () => at }
}

/** A scheduler on a TestClock that starts at `start` ms; `clock` moves it. */
async function testScheduler(driver: SqlDriver, alarm: Alarm["Service"], start = 1_000_000) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* TestClock.testClockWith(Effect.succeed)
      yield* clock.setTime(start)
      const scheduler = yield* makeAlarmScheduler(driver)
      return { scheduler, clock }
    }).pipe(Effect.provide(Layer.merge(Layer.succeed(Alarm, alarm), TestClock.layer()))),
  )
}

const drainServer = (contract: string, drained: string[]) =>
  ({ contract: { name: contract }, drain: async (sessionId: string) => { drained.push(sessionId) } }) as unknown as DrainableServer

/** Lets pending fibers run up to their next real wait. */
const settle = () => Bun.sleep(5)

function open(driver: SqlDriver, name: string, alarm: Alarm["Service"]) {
  cleanups.push(registerDriver(name, driver))
  const scheduler = Effect.runSync(makeAlarmScheduler(driver).pipe(Effect.provideService(Alarm, alarm)))
  const store = { log: a2SqliteStore({ path: name }), tables: sqlTables(boardDb(driver)), close: async () => {} }
  return { team: board({ backend: a2({ store, scheduler, blob: memoryBlob() }) }), scheduler }
}

const texts = async (team: ReturnType<typeof board>, channel: string) =>
  (await team.channel(channel).messages().catch(() => ({ messages: [] }))).messages.map((m: { text: string }) => m.text)

describe("makeAlarmScheduler", () => {
  test("a scheduled post sends after a restart, from the stored alarm", async () => {
    const dir = mkdtempSync(join(tmpdir(), "board-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, "board.db")
    const clock = fakeAlarm()

    const first = nodeSqlDriver(file)
    const before = open(first, "before", clock.alarm)
    await before.team.schedule("flight-sync", { text: "reminder: review PR #28", at: new Date(Date.now() + 300) })
    expect(clock.at()).not.toBeNull()
    first.close()                                    // the object is evicted; nothing in memory survives

    await Bun.sleep(400)
    const after = open(nodeSqlDriver(file), "after", clock.alarm)
    await after.team.channel("flight-sync").messages().catch(() => null)   // a request wakes the board
    // Board's own catch-up may already have sent it; the alarm must send it if not, and never twice.
    for (let i = 0; i < 20 && !(await texts(after.team, "flight-sync")).length; i++) {
      await after.scheduler.onAlarm()
      await Bun.sleep(50)
    }
    await after.scheduler.onAlarm()
    expect(await texts(after.team, "flight-sync")).toEqual(["reminder: review PR #28"])
  })

  test("a failing task stays, with a backoff, and the alarm still re-arms", async () => {
    const driver = nodeSqlDriver(":memory:")
    const alarm = fakeAlarm()
    const { scheduler } = await testScheduler(driver, alarm.alarm, 1_000_000)
    scheduler.handler()                              // mounted with no servers: delivery will fail
    await scheduler.schedule({ version: 1, kind: "drain", contract: "nope", sessionId: "s", dueAt: 999_999 })
    expect(alarm.at()).toBe(1_000_000)               // never set into the past
    await scheduler.onAlarm()
    const [row] = driver.all("select attempts, due_at, last_error from board_scheduler", [])
    expect(row?.attempts).toBe(1)
    expect(Number(row?.due_at)).toBe(1_000_000 + 5_000)
    expect(String(row?.last_error)).toContain("no server for contract nope")
    expect(alarm.at()).toBe(1_005_000)
  })

  test("a task due before handler() mounts waits for the mount, then runs", async () => {
    const driver = nodeSqlDriver(":memory:")
    const { scheduler } = await testScheduler(driver, fakeAlarm().alarm, 1_000_000)
    await scheduler.schedule({ version: 1, kind: "drain", contract: "c", sessionId: "s1", dueAt: 999_000 })

    let done = false
    const run = scheduler.onAlarm().then(() => { done = true })
    await settle()
    expect(done).toBe(false)                         // waiting, not failing

    const drained: string[] = []
    scheduler.handler(drainServer("c", drained))
    await run
    expect(drained).toEqual(["s1"])
    expect(driver.all("select count(*) as n from board_scheduler", [])).toEqual([{ n: 0 }])
  })

  test("a mount after 31 seconds: rows untouched, alarm re-armed, next alarm delivers", async () => {
    const driver = nodeSqlDriver(":memory:")
    const alarm = fakeAlarm()
    const { scheduler, clock } = await testScheduler(driver, alarm.alarm, 1_000_000)
    await scheduler.schedule({ version: 1, kind: "drain", contract: "c", sessionId: "late-mount", dueAt: 999_000 })

    const pending = scheduler.onAlarm()
    await settle()
    await Effect.runPromise(clock.adjust("31 seconds"))
    await pending
    // Not a task failure: no attempt counted, no error, due time unchanged; the alarm retries 5 s after the timeout.
    expect(driver.all("select attempts, due_at, last_error from board_scheduler", []))
      .toEqual([{ attempts: 0, due_at: 999_000, last_error: null }])
    expect(alarm.at()).toBe(1_035_000)

    const drained: string[] = []
    scheduler.handler(drainServer("c", drained))
    await scheduler.onAlarm()
    expect(drained).toEqual(["late-mount"])
    expect(driver.all("select count(*) as n from board_scheduler", [])).toEqual([{ n: 0 }])
  })

  test("overlapping schedules keep the earliest alarm", async () => {
    const driver = nodeSqlDriver(":memory:")
    const getStarted = Promise.withResolvers<void>()
    const firstGet = Promise.withResolvers<number | null>()
    let at: number | null = null
    let calls = 0
    const alarm: Alarm["Service"] = {
      get: () => {
        if (++calls === 1) { getStarted.resolve(); return firstGet.promise }
        return Promise.resolve(at)
      },
      set: async (next) => { at = next },
    }
    const { scheduler } = await testScheduler(driver, alarm, 1_000_000)
    const later = scheduler.schedule({ version: 1, kind: "drain", contract: "c", sessionId: "later", dueAt: 1_009_000 })
    await getStarted.promise                         // the first schedule() is parked on alarm.get()
    await scheduler.schedule({ version: 1, kind: "drain", contract: "c", sessionId: "earlier", dueAt: 1_003_000 })
    expect(at).toBe(1_003_000)
    firstGet.resolve(null)
    await later
    expect(at).toBe(1_003_000)
  })

  test("persisted retry attempts double across restarts and cap at ten minutes", async () => {
    const driver = nodeSqlDriver(":memory:")
    const alarm = fakeAlarm()
    const first = await testScheduler(driver, alarm.alarm)
    await first.scheduler.schedule({ version: 1, kind: "drain", contract: "c", sessionId: "retry", dueAt: 999_000 })
    for (let attempt = 1; attempt <= 10; attempt++) {
      const [before] = driver.all("select due_at from board_scheduler", [])
      const { scheduler, clock } = await testScheduler(driver, alarm.alarm, Number(before?.due_at))
      const now = clock.currentTimeMillisUnsafe()
      scheduler.handler({ contract: { name: "c" }, drain: async () => { throw new Error("delivery broken") } } as unknown as DrainableServer)
      await scheduler.onAlarm()
      const [row] = driver.all("select attempts, due_at, last_error from board_scheduler", [])
      expect(row).toEqual({ attempts: attempt, due_at: now + Math.min(5_000 * 2 ** (attempt - 1), 600_000), last_error: "delivery broken" })
    }
  })

  test("a due-row read failure is swallowed and the remaining task is re-armed", async () => {
    const sql = nodeSqlDriver(":memory:")
    let at: number | null = null
    let sets = 0
    const alarm: Alarm["Service"] = { get: async () => at, set: async (next) => { at = next; sets++ } }
    const brokenRead: SqlDriver = {
      exec: (text) => sql.exec(text),
      all: (text, values) => {
        if (text.includes("where due_at <=")) throw new Error("due read broken")
        return sql.all(text, values)
      },
      run: (text, values) => sql.run(text, values),
      transaction: (fn) => sql.transaction(fn),
      close: () => sql.close(),
    }
    const { scheduler } = await testScheduler(brokenRead, alarm, 1_000_000)
    await scheduler.schedule({ version: 1, kind: "drain", contract: "c", sessionId: "read-failure", dueAt: 999_000 })
    scheduler.handler()
    sets = 0
    await expect(scheduler.onAlarm()).resolves.toBeUndefined()
    expect(sets).toBe(1)
    expect(at).toBe(1_000_000)
    expect(sql.all("select attempts from board_scheduler", [])).toEqual([{ attempts: 0 }])
  })

  test("the same task scheduled twice is one row", async () => {
    const driver = nodeSqlDriver(":memory:")
    const { scheduler } = await testScheduler(driver, fakeAlarm().alarm)
    const task = { version: 1 as const, kind: "append" as const, id: "a1", contract: "c", sessionId: "s", dueAt: 2_000_000 }
    await scheduler.schedule(task as never)
    await scheduler.schedule(task as never)
    expect(driver.all("select count(*) as n from board_scheduler", [])).toEqual([{ n: 1 }])
  })

  test("the alarm is set to the earliest due_at", async () => {
    const driver = nodeSqlDriver(":memory:")
    const alarm = fakeAlarm()
    const { scheduler } = await testScheduler(driver, alarm.alarm, 1_000_000)
    await scheduler.schedule({ version: 1, kind: "drain", contract: "c", sessionId: "a", dueAt: 1_009_000 })
    await scheduler.schedule({ version: 1, kind: "drain", contract: "c", sessionId: "b", dueAt: 1_003_000 })
    await scheduler.schedule({ version: 1, kind: "drain", contract: "c", sessionId: "c", dueAt: 1_006_000 })
    expect(alarm.at()).toBe(1_003_000)
  })

  test("onAlarm never throws, even when the alarm cannot be set", async () => {
    const driver = nodeSqlDriver(":memory:")
    const broken: Alarm["Service"] = { get: async () => null, set: async () => { throw new Error("storage down") } }
    const { scheduler } = await testScheduler(driver, broken)
    driver.run("insert into board_scheduler (key, due_at, task) values ('k', 1, ?)",
      [JSON.stringify({ version: 1, kind: "drain", contract: "c", sessionId: "s", dueAt: 1 })])
    scheduler.handler()
    await expect(scheduler.onAlarm()).resolves.toBeUndefined()
  })
})

describe("alarmScheduler (Promise factory the host uses today)", () => {
  test("still schedules and arms", async () => {
    const driver = nodeSqlDriver(":memory:")
    const alarm = fakeAlarm()
    const scheduler = alarmScheduler(driver, alarm.alarm)
    const dueAt = Date.now() + 60_000
    await scheduler.schedule({ version: 1, kind: "drain", contract: "c", sessionId: "s", dueAt })
    expect(alarm.at()).toBe(dueAt)
  })
})
