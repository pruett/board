import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { board } from "@vercel/board"
import { a2, a2SqliteStore, memoryBlob, sqlTables } from "@board/internals"
import { boardDb, registerDriver, type SqlDriver } from "@board/sql"
import { nodeSqlDriver } from "@board/sql-node"
import { alarmScheduler, type Alarm } from "@board/scheduler-alarm"

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

/** A stored alarm, like a Durable Object's: one time, kept across "restarts". */
function fakeAlarm() {
  let at: number | null = null
  const alarm: Alarm = { get: async () => at, set: async (t) => { at = t } }
  return { alarm, at: () => at }
}

function open(driver: SqlDriver, name: string, alarm: Alarm) {
  cleanups.push(registerDriver(name, driver))
  const scheduler = alarmScheduler(driver, alarm)
  const store = { log: a2SqliteStore({ path: name }), tables: sqlTables(boardDb(driver)), close: async () => {} }
  return { team: board({ backend: a2({ store, scheduler, blob: memoryBlob() }) }), scheduler }
}

const texts = async (team: ReturnType<typeof board>, channel: string) =>
  (await team.channel(channel).messages().catch(() => ({ messages: [] }))).messages.map((m: { text: string }) => m.text)

describe("alarmScheduler", () => {
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
    const clock = fakeAlarm()
    const scheduler = alarmScheduler(driver, clock.alarm)
    scheduler.handler()                              // no servers mounted: delivery will fail
    await scheduler.schedule({ version: 1, kind: "drain", contract: "nope", sessionId: "s", dueAt: Date.now() - 1 })
    await scheduler.onAlarm()
    const [row] = driver.all("select attempts, due_at, last_error from board_scheduler", [])
    expect(row?.attempts).toBe(1)
    expect(Number(row?.due_at)).toBeGreaterThan(Date.now())
    expect(String(row?.last_error)).toContain("no server for contract nope")
    expect(clock.at()).toBe(Number(row?.due_at))
  })

  test("the same task scheduled twice is one row", async () => {
    const driver = nodeSqlDriver(":memory:")
    const scheduler = alarmScheduler(driver, fakeAlarm().alarm)
    const task = { version: 1 as const, kind: "append" as const, id: "a1", contract: "c", sessionId: "s", dueAt: Date.now() + 1000 }
    await scheduler.schedule(task as never)
    await scheduler.schedule(task as never)
    expect(driver.all("select count(*) as n from board_scheduler", [])).toEqual([{ n: 1 }])
  })
})
