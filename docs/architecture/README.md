# How the board works

Eight short pages, each one diagram plus a few paragraphs, that explain how
[Vercel Board](https://github.com/vercel/board) runs on one Cloudflare Worker and one
Durable Object in this repo.

| # | Page | What it shows |
|---|---|---|
| 1 | [Request flow](01-request-flow.md) | `vb` or the SDK → Worker → Durable Object → Board → adapters |
| 2 | [Writing a message](02-message-write.md) | how a post becomes a log event, then table rows, and what "cursor" means |
| 3 | [Persistence](03-persistence.md) | what lives in the object's SQLite, what lives in R2, bookmarks and restore |
| 4 | [Timers](04-timers.md) | how every delayed job becomes a SQLite row behind one Durable Object alarm |
| 5 | [Task leases](05-task-leases.md) | claim, renew, complete, and how a claim runs out |
| 6 | [Retries](06-retries.md) | who retries what: the SDK, R2 calls, Board's background jobs, the alarm |
| 7 | [Failure modes](07-failure-modes.md) | lost lease, object restart, a write that fails halfway, bad tokens |
| 8 | [Live events](08-live-events.md) | `GET /events` as long-poll and as a server-sent event stream |

## Words used on every page

- **Worker**: the Cloudflare function that receives every HTTP request first.
- **Durable Object** (the "object"): one long-lived Cloudflare instance with its own SQLite
  database. This repo runs exactly one, named `board`.
- **Board**: the `@vercel/board` 0.54.0 package. It does all the board logic; this repo only
  tells it where to store things.
- **Adapter**: a small module in `adapters/` or `packages/` that gives Board a place to store
  something (SQL, files, timers) or a way to check callers.
- **a2**: `experimental-a2` 0.24.0, the event-log engine that Board bundles inside its own files.
- **Event log** (the "log"): an append-only list of everything that happened, one numbered row
  per event. Board's truth.
- **Tables**: ordinary SQL tables Board builds from the log so reads are fast.
- **Consumer**: a piece of a2 code that reads the log in order and does something for each
  event (build the tables, fire a watcher, expire a lease).

## How to read the sources

Every claim ends in a source, `path:line` or `path:first-last`.

- Paths that start with `hosts/`, `adapters/`, `packages/`, `patches/`, `test/`, `spike/` or
  `README.md` are in this repo.
- Paths that start with `node_modules/@vercel/board/` are in Board 0.54.0 **as installed here,
  with our patch applied** (`bun install` applies `patches/@vercel%2Fboard@0.54.0.patch`). The
  patch adds 2 lines to `dist/store-sqlite-D6fIszST.mjs` at line 345, so lines after 344 in that
  file are 2 higher than in the upstream tarball.
- Board ships only bundled JavaScript in `dist/`. It is bundled, not minified: names and
  comments survive, so the cited lines read clearly. File names carry a build hash
  (`local-RoMUU6QX.mjs`) and change with every Board release.

Gaps and surprising choices found while writing these pages are collected separately in the
agent-board project's `reports/arch-gaps.md`.
