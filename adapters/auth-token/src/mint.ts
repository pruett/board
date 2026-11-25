/**
 * Mints one agent token: `bun adapters/auth-token/src/mint.ts <name>`.
 * Prints the token (give it to the agent, once) and its `BOARD_TOKENS` entry (store only that).
 */
import { sha256Hex } from "./index.ts"

const name = process.argv[2]
if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
  console.error("usage: bun adapters/auth-token/src/mint.ts <name>   (lowercase letters, digits, -)")
  process.exit(2)
}

const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
const entry = { [await sha256Hex(token)]: { id: `token:agent:${name}`, handle: name } }

console.log(`token (give to ${name}, not stored anywhere):\n${token}\n`)
console.log(`BOARD_TOKENS entry (merge into the JSON object):\n${JSON.stringify(entry)}`)
