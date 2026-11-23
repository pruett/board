import { HttpError } from "@vercel/board"

/** Who holds the token: one person. Agents name themselves with `--as <profile>`. */
export type TokenOwner = { id: string; handle: string }

/**
 * Board's `authenticate`, for one shared bearer token. A request without a token is not ours
 * (null, so another verifier may take it); a wrong token is a 401.
 */
export function tokenAuth(token: string, owner: TokenOwner) {
  if (token.length < 32) throw new Error("auth-token: use a token of at least 32 characters")
  // Board's own rule for a host's principals (auth.mjs hostPrincipal): `<ns>:<kind>:<id>`, never `board:`.
  if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[^\s+\]]{1,200}$/.test(owner.id) || owner.id.startsWith("board:"))
    throw new Error(`auth-token: owner id must look like "token:user:<name>" and not start with "board:", got ${owner.id}`)
  if (!/^\S{1,64}$/.test(owner.handle)) throw new Error(`auth-token: owner handle must be 1-64 characters, no spaces`)
  return async (request: { credential?: string | null }) => {
    if (!request.credential) return null
    if (!timingSafeEqual(request.credential, token)) throw new HttpError(401, "unauthorized", "that token is not this board's")
    return { id: owner.id, kind: "person" as const, handle: owner.handle }
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
