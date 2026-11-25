/** Starts one coding agent as a child process, tees its output, and kills it when its scope closes. */
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Context, Effect, Layer, Schema, type Scope } from "effect"

export interface Child {
  readonly pid: number
  /** The exit code, once the child has exited and its output is written. */
  readonly exited: Effect.Effect<number>
}

export interface StartOptions {
  readonly cwd: string
  /** Put before each output line on stdout. */
  readonly prefix: string
  /** Gets the child's whole output. */
  readonly logFile: string
}

export class LaunchError extends Schema.TaggedError<LaunchError>()("LaunchError", {
  argv0: Schema.String,
  message: Schema.String,
}) {}

export class Launcher extends Context.Service<Launcher, {
  readonly start: (argv: ReadonlyArray<string>, options: StartOptions) => Effect.Effect<Child, LaunchError, Scope.Scope>
}>()("@board/agent/Launcher") {
  static readonly layer = Layer.succeed(Launcher, Launcher.of({ start: (argv, options) => start(argv, options) }))
}

/** How long a child's process group gets after SIGTERM before SIGKILL. */
const killGraceMs = 10_000
/** How long output is still read after the child exits: a descendant may hold its pipes open. */
const drainMs = 2_000

/** Signals every process in the group the child leads; false when none is left. */
const signalGroup = (pid: number, signal: NodeJS.Signals | 0) => {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

const start = (argv: ReadonlyArray<string>, { cwd, prefix, logFile }: StartOptions) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        mkdirSync(dirname(logFile), { recursive: true })
        const log = Bun.file(logFile).writer()
        // Its own process group, so stopping it reaches every process it started.
        const proc = Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true })
        const tee = async (stream: ReadableStream<Uint8Array>, stop: Promise<unknown>) => {
          const reader = stream.getReader()
          void stop.then(() => reader.cancel().catch(() => undefined))
          const decoder = new TextDecoder()
          let rest = ""
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              log.write(value)
              const lines = (rest + decoder.decode(value, { stream: true })).split("\n")
              rest = lines.pop() ?? ""
              for (const line of lines) process.stdout.write(`${prefix} ${line}\n`)
            }
          } catch {
            // Canceled: the drain after exit is over.
          }
          if (rest !== "") process.stdout.write(`${prefix} ${rest}\n`)
        }
        // `done` follows the exit, never the pipes: once the child exits, its output is read for at most drainMs.
        const drained = proc.exited.then(() => Bun.sleep(drainMs))
        const done = Promise.all([proc.exited, Promise.race([Promise.all([tee(proc.stdout, drained), tee(proc.stderr, drained)]), drained])])
          .then(async ([code]) => {
            await log.end()
            return code
          })
        return { proc, done }
      },
      catch: (cause) => new LaunchError({ argv0: argv[0] ?? "", message: String(cause) }),
    }),
    ({ proc, done }) =>
      Effect.promise(async () => {
        // SIGTERM the whole group (the child may have exited and left descendants), SIGKILL whatever is left after the grace.
        if (signalGroup(proc.pid, "SIGTERM")) {
          const deadline = Date.now() + killGraceMs
          while (Date.now() < deadline && signalGroup(proc.pid, 0)) await Bun.sleep(100)
          signalGroup(proc.pid, "SIGKILL")
        }
        await done.catch(() => undefined)
      }),
  ).pipe(Effect.map(({ proc, done }): Child => ({ pid: proc.pid, exited: Effect.promise(() => done) })))
