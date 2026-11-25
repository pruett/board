/**
 * The board as one worker profile, through `bun run vb … --json`. The CLI keeps a claim per
 * profile in its local store, so the agent it starts can settle the task with the same `--as`.
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { Role } from "./roles.ts"

export interface Task {
  readonly id: string
  readonly channel: string
  readonly labels: Readonly<Record<string, string>>
}

/** One event a `wait` printed: where it sits in the event log, what happened, who did it, and its message. */
export interface BoardEvent {
  /** Pass to the next wait's `--after` so nothing between waits is missed. */
  readonly cursor: string
  /** e.g. message.posted, task.created, task.blocked, task.completed, task.failed */
  readonly type: string
  /** The actor who caused the event (not necessarily who wrote the message): its ID, e.g. `token:user:pruett+k2`. */
  readonly actor: string
  /** Whether that actor is a person or one of a person's agent profiles, and its handle (`pruett`, `pruett/k2`). */
  readonly actorKind: string
  readonly actorHandle: string
  /** The message it is about: the post itself, or a task's root. */
  readonly messageId: string
  /** The thread root the message replies to, null for a root. */
  readonly re: string | null
  /** When it happened, in ms since the epoch. */
  readonly at: number
}

export class BoardError extends Schema.TaggedError<BoardError>()("BoardError", {
  command: Schema.String,
  reason: Schema.String,
  message: Schema.String,
}) {}

export class Board extends Context.Service<Board, {
  /** Every channel path on the board. */
  readonly channels: Effect.Effect<Array<string>, BoardError>
  /** The hq thread labeled kind=role role=<role>. */
  readonly roleThread: (role: string) => Effect.Effect<string, BoardError>
  /** The newest thread in a channel with all these labels (`k=v`). */
  readonly threadByLabel: (channel: string, labels: ReadonlyArray<string>) => Effect.Effect<string, BoardError>
  /** The channel's cursor now; undefined for an empty channel. */
  readonly cursor: (channel: string) => Effect.Effect<string | undefined, BoardError>
  /** The next event in a channel matching `filters` (CLI flags) after `after`, waiting up to `timeout`; none on timeout. */
  readonly wait: (
    channel: string,
    filters: ReadonlyArray<string>,
    after: string | undefined,
    timeout: string,
  ) => Effect.Effect<Option.Option<BoardEvent>, BoardError>
  /** The oldest ready task for the role in a channel, waiting up to `wait`; none when nothing came. */
  readonly claimReady: (channel: string, role: Role, wait: string) => Effect.Effect<Option.Option<Task>, BoardError>
  readonly renew: (id: string) => Effect.Effect<void, BoardError>
  /** Whether this profile still holds the task's claim. */
  readonly holds: (id: string) => Effect.Effect<boolean, BoardError>
  readonly fail: (id: string, reason: string) => Effect.Effect<void, BoardError>
  readonly release: (id: string) => Effect.Effect<void, BoardError>
}>()("@board/agent/Board") {
  /** `vb` is the argv that runs the board CLI, e.g. `[bun, --no-env-file, <repo>/scripts/vb.ts]`. */
  static readonly cli = (options: { readonly vb: ReadonlyArray<string>; readonly profile: string }) =>
    Layer.succeed(Board, makeCli(options))
}

const TaskMessage = Schema.Struct({
  id: Schema.String,
  channel: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
  task: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    state: Schema.String,
    claim: Schema.NullOr(Schema.Struct({ actor: Schema.String })),
  }))),
})
const Claimed = Schema.Struct({ task: TaskMessage })
const Thread = Schema.Struct({ message: TaskMessage })
const Channels = Schema.Struct({
  channels: Schema.Array(Schema.Struct({ path: Schema.String })),
  next: Schema.NullOr(Schema.String),
})
const Threads = Schema.Struct({
  threads: Schema.Array(Schema.Struct({ message: Schema.Struct({ id: Schema.String }) })),
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const Actor = Schema.Struct({ id: Schema.String, kind: Schema.optionalKey(Schema.String), handle: Schema.optionalKey(Schema.String) })
const Waited = Schema.Struct({
  event: Schema.Struct({
    cursor: Schema.String,
    type: Schema.String,
    createdAt: Schema.String,
    actor: Schema.optionalKey(Schema.NullOr(Actor)),
    payload: Schema.optionalKey(Schema.Struct({ by: Schema.optionalKey(Schema.NullOr(Schema.Struct({ actor: Schema.String }))) })),
    message: Schema.Struct({ id: Schema.String, re: Schema.NullOr(Schema.String) }),
  }),
})
const Failure = Schema.Struct({ reason: Schema.String, message: Schema.String })

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const makeCli = ({ vb, profile }: { readonly vb: ReadonlyArray<string>; readonly profile: string }): Board["Service"] => {
  /** Runs one CLI command and returns its JSON; a non-zero exit becomes a BoardError with the CLI's reason. */
  const run = Effect.fnUntraced(function*(args: ReadonlyArray<string>) {
    const command = args.slice(0, 3).join(" ")
    const out = yield* Effect.tryPromise({
      try: async (signal) => {
        const proc = Bun.spawn([...vb, ...args, "--as", profile, "--json"], { stdout: "pipe", stderr: "pipe", stdin: "ignore", signal })
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        return { stdout, stderr, code }
      },
      catch: (cause) => new BoardError({ command, reason: "spawn", message: String(cause) }),
    })
    if (out.code === 0) return parseJson(out.stdout)
    const failure = Schema.decodeUnknownOption(Failure)(parseJson(out.stderr.trim()) ?? parseJson(out.stdout.trim()))
    return yield* Option.match(failure, {
      onNone: () => new BoardError({ command, reason: `exit ${out.code}`, message: (out.stderr || out.stdout).trim().slice(0, 500) }),
      onSome: (f) => new BoardError({ command, reason: f.reason, message: f.message }),
    })
  })

  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, command: string) => (json: unknown) =>
    Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError((e) => new BoardError({ command, reason: "bad_output", message: String(e) })),
    )

  const channels = Effect.gen(function*() {
    const paths: Array<string> = []
    let after: string | null = null
    do {
      const page: typeof Channels.Type = yield* run(["channels", "--limit", "500", ...(after === null ? [] : ["--after", after])]).pipe(
        Effect.flatMap(decode(Channels, "channels")),
      )
      paths.push(...page.channels.map((c) => c.path))
      after = page.next
    } while (after !== null)
    return paths
  })

  const threadByLabel = (channel: string, labels: ReadonlyArray<string>) =>
    run(["read", channel, ...labels.flatMap((l) => ["--label", l]), "--limit", "1"]).pipe(
      Effect.flatMap(decode(Threads, `read ${channel}`)),
      Effect.flatMap(({ threads }) => {
        const first = threads[0]
        return first === undefined
          ? Effect.fail(new BoardError({ command: `read ${channel}`, reason: "no_thread", message: `no ${channel} thread labeled ${labels.join(" ")}` }))
          : Effect.succeed(first.message.id)
      }),
    )

  const roleThread = (role: string) => threadByLabel("hq", ["kind=role", `role=${role}`])

  const cursor = (channel: string) =>
    run(["read", channel, "--limit", "1"]).pipe(
      Effect.flatMap(decode(Threads, `read ${channel}`)),
      Effect.map(({ cursor }) => cursor ?? undefined),
    )

  const wait = (channel: string, filters: ReadonlyArray<string>, after: string | undefined, timeout: string) =>
    run(["wait", channel, ...filters, ...(after === undefined ? [] : ["--after", after]), "--timeout", timeout]).pipe(
      Effect.flatMap(decode(Waited, "wait")),
      Effect.map(({ event }): Option.Option<BoardEvent> =>
        Option.some({
          cursor: event.cursor,
          type: event.type,
          actor: event.actor?.id ?? event.payload?.by?.actor ?? "",
          actorKind: event.actor?.kind ?? "",
          actorHandle: event.actor?.handle ?? "",
          messageId: event.message.id,
          re: event.message.re,
          at: Date.parse(event.createdAt),
        })
      ),
      Effect.catchIf((e) => e.reason === "timeout", () => Effect.succeed(Option.none<BoardEvent>())),
    )

  const claimReady = (channel: string, role: Role, wait: string) =>
    run(["tasks", "claim", "--ready", channel, "--label", `role=${role}`, "--wait", wait]).pipe(
      Effect.flatMap(decode(Claimed, "tasks claim")),
      Effect.map(({ task }): Option.Option<Task> => Option.some({ id: task.id, channel: task.channel, labels: task.labels })),
      Effect.catchIf((e) => e.reason === "nothing_ready" || e.reason === "timeout", () => Effect.succeed(Option.none<Task>())),
    )

  const holds = (id: string) =>
    run(["read", id]).pipe(
      Effect.flatMap(decode(Thread, "read")),
      Effect.map(({ message }) =>
        message.task?.state === "claimed" && (message.task.claim?.actor.endsWith(`+${profile}`) ?? false)
      ),
    )

  return Board.of({
    channels,
    roleThread,
    threadByLabel,
    cursor,
    wait,
    claimReady,
    renew: (id) => Effect.asVoid(run(["tasks", "renew", id])),
    holds,
    fail: (id, reason) => Effect.asVoid(run(["tasks", "fail", id, reason])),
    release: (id) => Effect.asVoid(run(["tasks", "release", id])),
  })
}
