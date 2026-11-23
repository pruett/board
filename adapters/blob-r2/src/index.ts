import { Data, Effect, Schedule } from "effect"
import type { BlobStore } from "@board/internals"

/** An R2 call that still failed after its retries. */
export class R2Error extends Data.TaggedError("R2Error")<{ readonly op: "put" | "get" | "head"; readonly key: string; readonly cause: unknown }> {}

/** The part of an R2 binding this adapter uses; a test can pass a fake. */
export type Bucket = Pick<R2Bucket, "put" | "get" | "head">

/** R2 answers a write only once it is on disk; a failed call is retried 3 times, 100 ms then doubling. */
const retry = Schedule.exponential("100 millis")

/**
 * Board's `BlobStore` on R2. Keys live under `prefix` (default `files/`), so one bucket can also
 * hold backups. No `uploadUrl`: R2 signs URLs only through its S3 API keys, so Board keeps
 * uploads at its 4 MB request limit until we add that.
 */
export function r2Blob(bucket: Bucket, prefix = "files/"): BlobStore {
  const call = <A>(op: R2Error["op"], key: string, run: () => Promise<A>) =>
    Effect.runPromise(
      Effect.tryPromise({ try: run, catch: (cause) => new R2Error({ op, key, cause }) }).pipe(
        Effect.retry({ times: 3, schedule: retry }),
        Effect.withSpan(`r2.${op}`, { attributes: { key } }),
      ),
    )
  return {
    put: async (key, data, contentType) => {
      await call("put", key, () => bucket.put(prefix + key, data, { httpMetadata: { contentType } }))
    },
    get: async (key) => {
      const object = await call("get", key, () => bucket.get(prefix + key))
      if (!object) return null
      return { data: object.body, contentType: object.httpMetadata?.contentType ?? "application/octet-stream" }
    },
    head: async (key) => {
      const object = await call("head", key, () => bucket.head(prefix + key))
      return object ? { size: object.size } : null
    },
  }
}
