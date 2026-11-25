/**
 * BOARD PATCH GUARD: a claim's proof settles a task only for the principal that claimed it.
 * Board 0.54.0 checks the proof alone, so another token that read it (a shared CLI claim store)
 * could complete someone else's claim. patches/@vercel%2Fboard@0.54.0.patch adds the check in
 * `fenced` (dist/local-*.mjs); if a Board upgrade drops it, this test fails.
 */
import { expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { board } from "@vercel/board"
import { a2, a2SqliteStore, memoryBlob, sqlTables } from "@board/internals"
import { nodeSqlDriver } from "@board/sql-node"
import { boardDb, registerDriver } from "@board/sql"
import { makeTokenAuth, sha256Hex } from "@board/auth-token"

const PERSON = "t".repeat(32)
const A = "agent-a-token-".repeat(4), B = "agent-b-token-".repeat(4)
const URL = "http://127.0.0.1:8799/api/board"

test("BOARD PATCH GUARD: only the principal that claimed a task settles it, even with its proof", async () => {
  const env = {
    BOARD_TOKEN: PERSON, BOARD_OWNER_ID: "token:user:kevin", BOARD_OWNER_HANDLE: "kevin",
    BOARD_TOKENS: JSON.stringify({
      [await sha256Hex(A)]: { id: "token:agent:agent-a", handle: "agent-a" },
      [await sha256Hex(B)]: { id: "token:agent:agent-b", handle: "agent-b" },
    }),
  }
  const authenticate = Effect.runSync(makeTokenAuth.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
  ))
  const name = "claim-principal-" + crypto.randomUUID()
  const driver = nodeSqlDriver(":memory:")
  const unregister = registerDriver(name, driver)
  try {
    const store = { log: a2SqliteStore({ path: name }), tables: sqlTables(boardDb(driver)), close: async () => {} }
    const team = board({ url: URL, backend: a2({ store, blob: memoryBlob() }), authenticate })
    const call = async (token: string, path: string, body: object, profile?: string) => {
      const response = await team.fetch(new Request(URL + path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(profile ? { "x-board-profile": profile } : {}),
        },
        body: JSON.stringify(body),
      }))
      return { status: response.status, body: await response.json() as any }
    }
    const code = (r: { body: any }) => r.body?.error?.code ?? r.body?.code

    // A creates and claims a task; B learns A's proof.
    const created = await call(A, "/tasks", { channel: "work", text: "A holds this claim", claim: true })
    expect(created.status).toBeLessThan(300)
    const id = String(created.body.task.id)
    const proof = { epoch: created.body.claim.epoch, token: created.body.claim.token }

    // B, with A's proof, can't renew, block, release, fail or complete it.
    for (const [path, extra] of [
      ["renew", {}], ["block", { reason: "B blocks" }], ["release", {}],
      ["fail", { reason: "B fails" }], ["complete", { result: "B completes" }],
    ] as const) {
      const refused = await call(B, `/tasks/${id}/${path}`, { ...proof, ...extra })
      expect({ path, status: refused.status, code: code(refused) }).toEqual({ path, status: 409, code: "claim_not_held" })
    }

    // A's own principal still holds it, under any of its profiles; A's complete settles it.
    expect((await call(A, `/tasks/${id}/renew`, proof, "worker")).status).toBeLessThan(300)
    const done = await call(A, `/tasks/${id}/complete`, { ...proof, result: "A completes" })
    expect(done.status).toBeLessThan(300)
    expect(done.body.task.task.state).toBe("completed")
  } finally {
    unregister()
    driver.close()
  }
})
