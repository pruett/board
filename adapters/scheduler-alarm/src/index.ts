import { Clock, Context, Deferred, Effect, Schema, Tracer } from "effect"
import {
  deliverSchedulerAppend, deliverSchedulerClear,
  type A2Scheduler, type DrainableServer, type SchedulerTask,
} from "@board/internals"
import type { SqlDriver } from "@board/sql"

/**
 * The one wake-up time a host keeps: a Durable Object's alarm (`storage.getAlarm`/`setAlarm`),
 * or a fake in tests. Promise-shaped, like the storage calls it wraps; the scheduler adapts it.
 */
export class Alarm extends Context.Service<Alarm, {
  get(): Promise<number | null>
  set(at: number): Promise<void>
}>()("board/Alarm") {}

/** Creating the `board_scheduler` table failed. */
export class SchedulerSetupError extends Schema.TaggedError<SchedulerSetupError>()("SchedulerSetupError", {
  cause: Schema.Defect(),
}) {}

/** A read or write of `board_scheduler` failed. */
export class SchedulerSqlError extends Schema.TaggedError<SchedulerSqlError>()("SchedulerSqlError", {
  cause: Schema.Defect(),
}) {}

/** Reading or setting the host's alarm failed. */
export class AlarmError extends Schema.TaggedError<AlarmError>()("AlarmError", {
  op: Schema.Literals(["get", "set"]),
  cause: Schema.Defect(),
}) {}

/** A due task could not be delivered; its `message` is stored as the row's `last_error`. */
export class DeliveryError extends Schema.TaggedError<DeliveryError>()("DeliveryError", {
  kind: Schema.String,
  contract: Schema.String,
  message: Schema.String,
}) {}

/** A failed task waits 5 s, doubling, up to 10 minutes; it is never dropped. Persisted per row, so not a `Schedule`. */
const backoff = (attempts: number) => Math.min(5_000 * 2 ** (attempts - 1), 600_000)

/** How long an alarm waits for `handler()` to mount the servers before failing its due tasks. */
const MOUNT_TIMEOUT = "30 seconds"

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

const sqlTry = <A>(f: () => A) => Effect.try({ try: f, catch: (cause) => new SchedulerSqlError({ cause }) })

/**
 * a2's scheduler on a host's stored alarm. Each task is a row in `board_scheduler`, written
 * before `schedule` returns, so a restart loses nothing; the alarm is set to the earliest
 * `due_at`. Alarms run at least once, so a task can run twice: a2's drains and its
 * appends and clears, keyed by id, are safe to repeat. An alarm that fires before
 * `handler()` mounts the servers waits for the mount (up to 30 s) instead of failing.
 *
 * The SQL driver is a parameter, not a service: it is synchronous and shared with the
 * host's other SQL users. Time comes from `Clock`; every Promise method runs with the
 * context captured here, so it shares the caller's logger, tracer and clock.
 */
export const makeAlarmScheduler = Effect.fn("scheduler-alarm.make")(function* (
  sql: SqlDriver,
): Effect.fn.Return<AlarmScheduler, SchedulerSetupError, Alarm> {
  yield* Effect.try({ try: () => sql.exec(TABLE), catch: (cause) => new SchedulerSetupError({ cause }) })
  const alarm = yield* Alarm
  // Without the constructor's span: each Promise call is its own trace, not a child of `make`.
  const ctx = Context.omit(Tracer.ParentSpan)(yield* Effect.context<Alarm>())
  const mounted = yield* Deferred.make<ReadonlyArray<DrainableServer>>()

  const alarmGet = Effect.tryPromise({ try: () => alarm.get(), catch: (cause) => new AlarmError({ op: "get", cause }) })
  const alarmSet = (at: number) =>
    Effect.tryPromise({ try: () => alarm.set(at), catch: (cause) => new AlarmError({ op: "set", cause }) })

  /** Sets the alarm to the earliest due task. `always`: after an alarm ran, its time is spent, so set it even if later. */
  const armNext = Effect.fn("scheduler-alarm.armNext")(function* (always: boolean) {
    const [row] = yield* sqlTry(() => sql.all("select min(due_at) as at from board_scheduler", []))
    const at = row?.at == null ? null : Number(row.at)
    if (at === null) return
    const current = always ? null : yield* alarmGet
    if (current === null || current > at) yield* alarmSet(Math.max(at, yield* Clock.currentTimeMillis))
  })

  const deliver = Effect.fn("scheduler-alarm.deliver")(function* (
    servers: ReadonlyArray<DrainableServer> | null,
    task: SchedulerTask,
  ) {
    const fail = (message: string) => new DeliveryError({ kind: task.kind, contract: task.contract, message })
    if (servers === null) return yield* fail(`no servers mounted after ${MOUNT_TIMEOUT}`)
    const server = servers.find((s) => s.contract.name === task.contract)
    if (!server) return yield* fail(`no server for contract ${task.contract}`)
    yield* Effect.tryPromise({
      try: (): Promise<unknown> =>
        task.kind === "drain" ? server.drain(task.sessionId)
          : task.kind === "append" ? deliverSchedulerAppend(server, task)
          : deliverSchedulerClear(server, task),
      catch: (cause) => fail(cause instanceof Error ? cause.message : String(cause)),
    })
  })

  const runDue = Effect.fn("scheduler-alarm.runDue")(function* () {
    const start = yield* Clock.currentTimeMillis
    const due = yield* sqlTry(() =>
      sql.all("select key, task, attempts from board_scheduler where due_at <= ? order by due_at", [start]))
    if (due.length === 0) return
    // An alarm can fire while the object is still starting: wait for `handler()` rather than fail every task.
    const servers = yield* Deferred.await(mounted).pipe(
      Effect.timeoutOrElse({ duration: MOUNT_TIMEOUT, orElse: () => Effect.succeed(null) }),
    )
    for (const row of due) {
      const key = String(row.key), task = JSON.parse(String(row.task)) as SchedulerTask
      const result = yield* Effect.result(deliver(servers, task))
      if (result._tag === "Success") {
        yield* sqlTry(() => sql.run("delete from board_scheduler where key = ?", [key]))
      } else {
        const attempts = Number(row.attempts) + 1
        const now = yield* Clock.currentTimeMillis
        yield* sqlTry(() =>
          sql.run("update board_scheduler set attempts = ?, due_at = ?, last_error = ? where key = ?",
            [attempts, now + backoff(attempts), result.failure.message, key]))
        yield* Effect.logWarning(`[board] scheduled ${task.kind} failed, attempt ${attempts}`, result.failure)
      }
    }
  })

  const schedule = Effect.fn("scheduler-alarm.schedule")(function* (task: SchedulerTask) {
    yield* sqlTry(() =>
      sql.run(
        "insert into board_scheduler (key, due_at, task) values (?, ?, ?) on conflict (key) do nothing",
        [keyOf(task), task.dueAt, JSON.stringify(task)],
      ))
    yield* armNext(false)
  })

  // Catch everything and set the next alarm ourselves: Cloudflare retries a throwing alarm only 6 times.
  const onAlarm = runDue().pipe(
    Effect.catchCause((cause) => Effect.logError("[board] alarm run failed", cause)),
    Effect.andThen(armNext(true)),
    Effect.catchCause((cause) => Effect.logError("[board] could not set the next alarm", cause)),
    Effect.withSpan("scheduler-alarm.onAlarm"),
  )

  const run = Effect.runPromiseWith(ctx)
  return {
    schedule: (task) => run(schedule(task)),
    handler(...servers) {
      Deferred.doneUnsafe(mounted, Effect.succeed(servers))
      return async () => new Response(null, { status: 204 })
    },
    onAlarm: () => run(onAlarm),
  }
})
