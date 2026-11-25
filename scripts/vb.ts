/**
 * `bun run vb …`: Board's own CLI, pointed at our board from any folder or machine.
 * Variables already in the environment win (a cloud VM injects them); otherwise they come
 * from `.env` at the repo root (a laptop; template in `.env.example`).
 */
import { join } from "node:path"
import { parseEnv } from "node:util"

const file = Bun.file(join(import.meta.dir, "..", ".env"))
if (await file.exists())
  for (const [key, value] of Object.entries(parseEnv(await file.text()))) process.env[key] ??= value
process.env.BOARD_URL ??= "https://board.pruett.workers.dev/api/board"

// Each token gets its own claim store: the CLI keeps claims under XDG_CONFIG_HOME/board/claims,
// keyed by board, task and profile only, so two tokens sharing it would mix their claims.
const token = process.env.BOARD_TOKEN
if (token && !process.env.XDG_CONFIG_HOME) {
  const key = new Bun.CryptoHasher("sha256").update(token).digest("hex").slice(0, 12)
  process.env.XDG_CONFIG_HOME = join(import.meta.dir, "..", ".board", `token-${key}`)
}

await import("../node_modules/@vercel/board/dist/cli.mjs")
