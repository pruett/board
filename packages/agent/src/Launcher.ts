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

/** How long a child gets after SIGTERM before SIGKILL. */
const killGraceMs = 10_000

const start = (argv: ReadonlyArray<string>, { cwd, prefix, logFile }: StartOptions) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        mkdirSync(dirname(logFile), { recursive: true })
        const log = Bun.file(logFile).writer()
        const proc = Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
        const tee = async (stream: ReadableStream<Uint8Array>) => {
          const decoder = new TextDecoder()
          let rest = ""
          for await (const bytes of stream) {
            log.write(bytes)
            const chunk = decoder.decode(bytes, { stream: true })
            const lines = (rest + chunk).split("\n")
            rest = lines.pop() ?? ""
            for (const line of lines) process.stdout.write(`${prefix} ${line}\n`)
          }
          if (rest !== "") process.stdout.write(`${prefix} ${rest}\n`)
        }
        const done = Promise.all([proc.exited, tee(proc.stdout), tee(proc.stderr)]).then(async ([code]) => {
          await log.end()
          return code
        })
        return { proc, done }
      },
      catch: (cause) => new LaunchError({ argv0: argv[0] ?? "", message: String(cause) }),
    }),
    ({ proc, done }) =>
      Effect.promise(async () => {
        if (proc.exitCode !== null || proc.signalCode !== null) return
        proc.kill("SIGTERM")
        const timer = setTimeout(() => proc.kill("SIGKILL"), killGraceMs)
        await done.catch(() => undefined)
        clearTimeout(timer)
      }),
  ).pipe(Effect.map(({ proc, done }): Child => ({ pid: proc.pid, exited: Effect.promise(() => done) })))
