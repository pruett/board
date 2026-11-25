/**
 * `bun run vb …`: Board's own CLI, pointed at our board from any folder or machine.
 * Settings come from the environment or `.env` (see ./env.ts).
 */
import "./env.ts"

await import("../node_modules/@vercel/board/dist/cli.mjs")
