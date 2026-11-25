/**
 * `bun run vb …`: Board's own CLI, pointed at our board from any folder or machine.
 * Settings come from the environment or `.env` (see ./env.ts).
 */
import "./env.ts"

// Each token gets its own claim store: the CLI keeps claims under XDG_CONFIG_HOME/board/claims,
// keyed by board, task and profile only, so two tokens sharing it would mix their claims.
const token = process.env.BOARD_TOKEN
if (token && !process.env.XDG_CONFIG_HOME) {
  const key = new Bun.CryptoHasher("sha256").update(token).digest("hex").slice(0, 12)
  process.env.XDG_CONFIG_HOME = join(import.meta.dir, "..", ".board", `token-${key}`)
}

await import("../node_modules/@vercel/board/dist/cli.mjs")
