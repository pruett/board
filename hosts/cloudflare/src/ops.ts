/**
 * Operator routes under `/_ops/`, the same bearer token as the Board. They reach
 * Cloudflare's point-in-time restore, which only code inside the object can call.
 *
 *   GET  /_ops/bookmark              the storage's current bookmark
 *   POST /_ops/restore {"at": iso}         restore SQLite as it was at `at` (last 30 days), then restart
 *   POST /_ops/restore {"bookmark": "…"}   restore to a bookmark from /_ops/bookmark: exact, no clock skew
 */
export const OPS_PREFIX = "/_ops/"

export async function handleOps(request: Request, ctx: DurableObjectState): Promise<Response> {
  const path = new URL(request.url).pathname.slice(OPS_PREFIX.length)
  if (request.method === "GET" && path === "bookmark")
    return Response.json({ bookmark: await ctx.storage.getCurrentBookmark(), at: new Date().toISOString() })
  if (request.method === "POST" && path === "restore") {
    const body = (await request.json().catch(() => null)) as { at?: string; bookmark?: string } | null
    const at = body?.at ? new Date(body.at) : null
    if (!body?.bookmark && (!at || Number.isNaN(at.getTime())))
      return Response.json({ error: 'send {"bookmark": "<from /_ops/bookmark>"} or {"at": "<ISO time>"}' }, { status: 400 })
    const bookmark = body?.bookmark ?? (await ctx.storage.getBookmarkForTime(at!))
    await ctx.storage.onNextSessionRestoreBookmark(bookmark)
    // Restart after this answer is sent; the next request opens the restored database.
    setTimeout(() => ctx.abort("restoring to " + bookmark), 50)
    return Response.json({ restoring: bookmark, ...(at ? { at: at.toISOString() } : {}) })
  }
  return Response.json({ error: "no such operation" }, { status: 404 })
}

/** The Worker checks the token for `/_ops/` itself: Board's auth does not see these routes. */
export function opsAuthorized(request: Request, token: string): boolean {
  const given = request.headers.get("authorization") ?? ""
  const want = `Bearer ${token}`
  if (given.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0
}
