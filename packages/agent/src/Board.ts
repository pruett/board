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
const Threads = Schema.Struct({ threads: Schema.Array(Schema.Struct({ message: Schema.Struct({ id: Schema.String }) })) })
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

  const roleThread = (role: string) =>
    run(["read", "hq", "--label", "kind=role", "--label", `role=${role}`, "--limit", "1"]).pipe(
      Effect.flatMap(decode(Threads, "read hq")),
      Effect.flatMap(({ threads }) => {
        const first = threads[0]
        return first === undefined
          ? Effect.fail(new BoardError({ command: "read hq", reason: "no_role_thread", message: `no hq thread labeled kind=role role=${role}` }))
          : Effect.succeed(first.message.id)
      }),
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
    claimReady,
    renew: (id) => Effect.asVoid(run(["tasks", "renew", id])),
    holds,
    fail: (id, reason) => Effect.asVoid(run(["tasks", "fail", id, reason])),
    release: (id) => Effect.asVoid(run(["tasks", "release", id])),
  })
}
