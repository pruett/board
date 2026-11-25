import { Context, Effect, Schedule, Schema } from "effect"
import type { BlobStore } from "@board/internals"

/** The part of an R2 binding this adapter uses; a test can pass a fake. */
export type Bucket = Pick<R2Bucket, "put" | "get" | "head">

/** The R2 bucket that holds Board's attachments. */
export class R2 extends Context.Service<R2, Bucket>()("board/R2") {}

/** An R2 call that still failed after its retries. */
export class R2Error extends Schema.TaggedError<R2Error>()("R2Error", {
  op: Schema.Literals(["put", "get", "head"]),
  key: Schema.String,
  cause: Schema.Defect(),
}) {}

/** R2 answers a write only once it is on disk; a failed call is retried 3 times, 100 ms then doubling. */
export const defaultRetry: Schedule.Schedule<unknown, unknown> = Schedule.exponential("100 millis")

export type R2BlobOptions = {
  /** Key prefix inside the bucket, so one bucket can also hold backups. Default `files/`. */
  readonly prefix?: string
  /** Delay between the 3 retries. Default {@link defaultRetry}; tests pass a tiny one. */
  readonly retry?: Schedule.Schedule<unknown, unknown>
}

/**
 * Board's `BlobStore` on the {@link R2} bucket. Every call runs with the context captured here,
 * so it shares the host's logger and tracer. No `uploadUrl`: R2 signs URLs only through its S3
 * API keys, so Board keeps uploads at its 4 MB request limit until we add that.
 */
export const makeR2Blob = Effect.fn("blob-r2.make")(function*(options: R2BlobOptions = {}): Effect.fn.Return<BlobStore, never, R2> {
  const bucket = yield* R2
  const ctx = yield* Effect.context<never>()
  const run = Effect.runPromiseWith(ctx)
  const prefix = options.prefix ?? "files/"
  const schedule = options.retry ?? defaultRetry

  const call = <A>(op: R2Error["op"], key: string, attempt: () => Promise<A>) =>
    Effect.tryPromise({ try: attempt, catch: (cause) => new R2Error({ op, key, cause }) }).pipe(
      Effect.retry({ times: 3, schedule }),
    )

  const put = Effect.fn("blob-r2.put")(function*(key: string, data: Uint8Array, contentType: string) {
    yield* Effect.annotateCurrentSpan({ key })
    yield* call("put", key, () => bucket.put(prefix + key, data, { httpMetadata: { contentType } }))
  })

  const get = Effect.fn("blob-r2.get")(function*(key: string) {
    yield* Effect.annotateCurrentSpan({ key })
    const object = yield* call("get", key, () => bucket.get(prefix + key))
    if (!object) return null
    return { data: object.body, contentType: object.httpMetadata?.contentType ?? "application/octet-stream" }
  })

  const head = Effect.fn("blob-r2.head")(function*(key: string) {
    yield* Effect.annotateCurrentSpan({ key })
    const object = yield* call("head", key, () => bucket.head(prefix + key))
    return object ? { size: object.size } : null
  })

  return {
    put: (key, data, contentType) => run(put(key, data, contentType)),
    get: (key) => run(get(key)),
    head: (key) => run(head(key)),
  }
})
