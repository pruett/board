# board

[Vercel Board](https://github.com/vercel/board) hosted on Cloudflare: one Board on one
Durable Object, with storage adapters we own.

v1 uses Board's own concepts unchanged (channels, threads, tasks, claims, attachments,
schedules) and replaces only where they are stored:

| Board seam | Adapter | Cloudflare |
|---|---|---|
| event log (a2 `store-sqlite`) | `sql-do` | Durable Object SQLite |
| tables (`Db`) | `db-do`, commits in `transactionSync` | Durable Object SQLite |
| scheduler | `scheduler-alarm` | Durable Object alarm |
| attachments (`BlobStore`) | `blob-r2` | R2 |
| callers (`authenticate`) | `auth-token` | Worker secret |

Clients use Board's own `vb` CLI and SDK with `BOARD_URL` pointed at the Worker.

Done when `vb conformance` passes on the Worker and messages, tasks, claims,
attachments and schedules survive a restart, a failed commit, and a restore.

`spike/` holds the first experiment (2026-11-22) that ran Board inside a Durable Object
under `wrangler dev`; see `spike/README.md`.
