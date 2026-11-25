import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
import { makeR2Blob, R2, r2Blob, type Bucket } from "@board/blob-r2"

/** An in-memory stand-in for an R2 bucket that fails the first `failures` calls. */
function fakeBucket(failures = 0) {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>()
  const state = { calls: 0 }
  const flaky = () => { if (state.calls++ < failures) throw new Error("R2 hiccup") }
  const bucket = {
    async put(key: string, data: Uint8Array, opts: { httpMetadata: { contentType: string } }) {
      flaky(); objects.set(key, { bytes: data, contentType: opts.httpMetadata.contentType }); return {}
    },
    async get(key: string) {
      flaky(); const o = objects.get(key)
      return o ? { body: new Blob([o.bytes]).stream(), httpMetadata: { contentType: o.contentType } } : null
    },
    async head(key: string) { flaky(); const o = objects.get(key); return o ? { size: o.bytes.length } : null },
  }
  return { bucket: bucket as unknown as Bucket, objects, state }
}

/** The store on a fake bucket, with a 1 ms retry so the tests stay fast. */
const make = (bucket: Bucket, prefix?: string) =>
  Effect.runPromise(makeR2Blob({ prefix, retry: Schedule.spaced("1 millis") }).pipe(Effect.provide(Layer.succeed(R2, bucket))))

describe("makeR2Blob", () => {
  test("stores under the prefix and reads back bytes and type", async () => {
    const { bucket, objects } = fakeBucket()
    const blob = await make(bucket)
    await blob.put("abc", new TextEncoder().encode("png bytes"), "image/png")
    expect([...objects.keys()]).toEqual(["files/abc"])
    const got = await blob.get("abc")
    expect(got?.contentType).toBe("image/png")
    expect(await new Response(got!.data as ReadableStream).text()).toBe("png bytes")
    expect(await blob.head!("abc")).toEqual({ size: 9 })
  })

  test("a miss is null", async () => {
    const blob = await make(fakeBucket().bucket)
    expect(await blob.get("missing")).toBeNull()
    expect(await blob.head!("missing")).toBeNull()
  })

  test("keeps a custom prefix and falls back to application/octet-stream", async () => {
    const { bucket, objects } = fakeBucket()
    objects.set("b/k", { bytes: new Uint8Array([1]), contentType: undefined as unknown as string })
    const got = await (await make(bucket, "b/")).get("k")
    expect(got?.contentType).toBe("application/octet-stream")
  })

  test("retries a failing call, then succeeds", async () => {
    const { bucket, state } = fakeBucket(3)
    const blob = await make(bucket)
    await blob.put("k", new Uint8Array([1]), "application/octet-stream")
    expect(state.calls).toBe(4)
    expect(await blob.head!("k")).toEqual({ size: 1 })
  })

  test("gives up after 3 retries with an R2Error", async () => {
    const { bucket, state } = fakeBucket(10)
    const blob = await make(bucket)
    await expect(blob.put("k", new Uint8Array([1]), "x")).rejects.toMatchObject({ _tag: "R2Error", op: "put", key: "k" })
    expect(state.calls).toBe(4)
  })
})

describe("r2Blob (deprecated wrapper)", () => {
  test("round trips under files/", async () => {
    const { bucket, objects } = fakeBucket()
    const blob = r2Blob(bucket)
    await blob.put("abc", new Uint8Array([1, 2]), "image/png")
    expect([...objects.keys()]).toEqual(["files/abc"])
    expect(await blob.head!("abc")).toEqual({ size: 2 })
  })
})
