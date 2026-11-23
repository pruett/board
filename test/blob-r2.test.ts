import { describe, expect, test } from "bun:test"
import { r2Blob, type Bucket } from "@board/blob-r2"

/** An in-memory stand-in for an R2 bucket that fails the first `failures` calls. */
function fakeBucket(failures = 0) {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>()
  let calls = 0
  const flaky = () => { if (calls++ < failures) throw new Error("R2 hiccup") }
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
  return { bucket: bucket as unknown as Bucket, objects }
}

describe("r2Blob", () => {
  test("stores under the prefix and reads back bytes and type", async () => {
    const { bucket, objects } = fakeBucket()
    const blob = r2Blob(bucket)
    await blob.put("abc", new TextEncoder().encode("png bytes"), "image/png")
    expect([...objects.keys()]).toEqual(["files/abc"])
    const got = await blob.get("abc")
    expect(got?.contentType).toBe("image/png")
    expect(await new Response(got!.data as ReadableStream).text()).toBe("png bytes")
    expect(await blob.head!("abc")).toEqual({ size: 9 })
    expect(await blob.get("missing")).toBeNull()
  })

  test("retries a failing call", async () => {
    const { bucket } = fakeBucket(2)
    await r2Blob(bucket).put("k", new Uint8Array([1]), "application/octet-stream")
    expect(await r2Blob(bucket).head!("k")).toEqual({ size: 1 })
  })

  test("gives up after 3 retries with the key in the error", async () => {
    const { bucket } = fakeBucket(10)
    await expect(r2Blob(bucket).put("k", new Uint8Array([1]), "x")).rejects.toMatchObject({ _tag: "R2Error", op: "put", key: "k" })
  })
})
