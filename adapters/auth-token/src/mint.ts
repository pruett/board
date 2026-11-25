/**
 * Mints one agent token: `bun adapters/auth-token/src/mint.ts <name> [can]`.
 * Prints the token (give it to the agent, once) and its `BOARD_TOKENS` entry (store only that).
 *
 * `can` is optional JSON in a grant's shape, `{"<channel pattern>": ["read", ...] | "all"}`. Without it
 * the entry names none, and the agent gets the default: read, post, react and label on every channel
 * (`{"*": ["read","post","react","label"]}`), never manage or sync, so it can't cancel, block or reopen
 * another agent's task. See adapters/auth-token/README.md.
 */
import { Result } from "effect"
import { agentScope, sha256Hex } from "./index.ts"

const [name, canJson] = process.argv.slice(2)
if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
  console.error(`usage: bun adapters/auth-token/src/mint.ts <name> ['{"fleet2/": ["read","post","react","label","manage"]}']`)
  console.error("  name: lowercase letters, digits, -   can: optional; default read, post, react, label on every channel")
  process.exit(2)
}

// The same check BOARD_TOKENS gets: patterns and permissions as a structure, then as header text.
let can: unknown
if (canJson !== undefined) {
  try {
    can = JSON.parse(canJson)
  } catch (error) {
    console.error(`can must be JSON like {"*": ["read","post"]}: ${error instanceof Error ? error.message : error}`)
    process.exit(2)
  }
  const checked = agentScope(can)
  if (Result.isFailure(checked)) {
    console.error(`can must be JSON like {"*": ["read","post"]}: ${checked.failure}`)
    process.exit(2)
  }
}

const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
const entry = { [await sha256Hex(token)]: { id: `token:agent:${name}`, handle: name, ...(can ? { can } : {}) } }

console.log(`token (give to ${name}, not stored anywhere):\n${token}\n`)
console.log(`BOARD_TOKENS entry (merge into the JSON object):\n${JSON.stringify(entry)}`)
if (!can) console.log(`\n(no can: ${name} gets read, post, react, label on every channel)`)
