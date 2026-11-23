import { Effect } from "effect"
import {
  deliverSchedulerAppend, deliverSchedulerClear,
  type A2Scheduler, type DrainableServer, type SchedulerTask,
} from "@board/internals"
import type { SqlDriver } from "@board/sql"

/** The one wake-up time a host keeps: a Durable Object's alarm, or a fake in tests. */
export interface Alarm {
  get(): Promise<number | null>
  set(at: number): Promise<void>
}

/** A failed task waits 5 s, doubling, up to 10 minutes; it is never dropped. */
const backoff = (attempts: number) => Math.min(5_000 * 2 ** (attempts - 1), 600_000)

const TABLE = `create table if not exists board_scheduler (
  key text primary key,
  due_at integer not null,
  task text not null,
  attempts integer not null default 0,
  last_error text
)`

/** a2's dedup key: one drain per session and time; appends and clears by their own id. */
const keyOf = (task: SchedulerTask) =>
  task.kind === "drain" ? `drain\u001f${task.contract}\u001f${task.sessionId}\u001f${task.dueAt}` : task.id

export type AlarmScheduler = A2Scheduler & {
  /** Call from the Durable Object's `alarm()`: runs what is due, then sets the next alarm. Never throws. */
  onAlarm(): Promise<void>
}

/**
 * a2's scheduler on a host's stored alarm. Each task is a row in `board_scheduler`, written
 * before `schedule` returns, so a restart loses nothing; the alarm is set to the earliest
 * `due_at`. Alarms run at least once, so a task can run twice: a2's drains and its
 * appends and clears, keyed by id, are safe to repeat.
 */
export function alarmScheduler(sql: SqlDriver, alarm: Alarm, now: () => number = Date.now): AlarmScheduler {
  sql.exec(TABLE)
  let servers: DrainableServer[] = []

  /** Sets the alarm to the earliest due task. `always`: after an alarm ran, its time is spent, so set it even if later. */
  const armNext = (always: boolean) => Effect.tryPromise(async () => {
    const [row] = sql.all("select min(due_at) as at from board_scheduler", [])
    const at = row?.at == null ? null : Number(row.at)
    if (at === null) return
    const current = always ? null : await alarm.get()
    if (current === null || current > at) await alarm.set(Math.max(at, now()))
  })

  const deliver = (task: SchedulerTask) =>
    Effect.tryPromise(async () => {
      const server = servers.find((s) => s.contract.name === task.contract)
      if (!server) throw new Error(`no server for contract ${task.contract}`)
      if (task.kind === "drain") await server.drain(task.sessionId)
      else if (task.kind === "append") await deliverSchedulerAppend(server, task)
      else await deliverSchedulerClear(server, task)
    })

  const runDue = Effect.gen(function* () {
    const due = sql.all("select key, task, attempts from board_scheduler where due_at <= ? order by due_at", [now()])
    for (const row of due) {
      const key = String(row.key), task = JSON.parse(String(row.task)) as SchedulerTask
      const result = yield* Effect.result(deliver(task))
      if (result._tag === "Success") {
        sql.run("delete from board_scheduler where key = ?", [key])
      } else {
        const attempts = Number(row.attempts) + 1
        sql.run("update board_scheduler set attempts = ?, due_at = ?, last_error = ? where key = ?",
          [attempts, now() + backoff(attempts), String(result.failure.cause ?? result.failure), key])
        yield* Effect.logWarning(`[board] scheduled ${task.kind} failed, attempt ${attempts}`, result.failure)
      }
    }
  })

  return {
    async schedule(task) {
      sql.run(
        "insert into board_scheduler (key, due_at, task) values (?, ?, ?) on conflict (key) do nothing",
        [keyOf(task), task.dueAt, JSON.stringify(task)],
      )
      await Effect.runPromise(armNext(false))
    },
    handler(...mounted) {
      servers = mounted
      return async () => new Response(null, { status: 204 })
    },
    async onAlarm() {
      // Catch everything and set the next alarm ourselves: Cloudflare retries a throwing alarm only 6 times.
      await Effect.runPromise(
        runDue.pipe(
          Effect.catchCause((cause) => Effect.logError("[board] alarm run failed", cause)),
          Effect.andThen(armNext(true)),
          Effect.catchCause((cause) => Effect.logError("[board] could not set the next alarm", cause)),
        ),
      )
    },
  }
}
