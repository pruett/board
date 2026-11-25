/**
 * Loads our board's settings into `process.env` for `bun run vb` and `bun run agent`.
 * Variables already in the environment win (a cloud VM injects them); otherwise they come
 * from `.env` at the repo root (a laptop; template in `.env.example`).
 */
import { join } from "node:path"
import { parseEnv } from "node:util"

export const repoRoot = join(import.meta.dir, "..")

const file = Bun.file(join(repoRoot, ".env"))
if (await file.exists())
  for (const [key, value] of Object.entries(parseEnv(await file.text()))) process.env[key] ??= value
process.env.BOARD_URL ??= "https://board.pruett.workers.dev/api/board"
