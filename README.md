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

## Status

| Check | Where | Result |
|---|---|---|
| `vb conformance` | `wrangler dev`, full stack | 86 passed, 5 skipped (Vercel-team checks) |
| Records, labels, claims after restart | `wrangler dev` | kept |
| Attachment after restart | `wrangler dev`, R2 | kept |
| Scheduled post across a restart | `wrangler dev`, alarm | sent on time, no request needed |
| A commit that fails halfway | `bun test` | writes nothing |
| `vb conformance` | deployed, `board.pruett.workers.dev` | 86 passed, 5 skipped |
| CPU per request | deployed, 222 requests sampled by `wrangler tail` during conformance | p50 1 ms, p90 12 ms, p99 21 ms, max 35 ms; no request ran out of CPU |
| Point-in-time restore | deployed, `/_ops/restore` with a bookmark | rolls back exactly to the bookmark; writes work after |
| Off-object backup and replay | | not yet |

## Operate

The deployed board: `BOARD_URL=https://board.pruett.workers.dev/api/board`, with the
`BOARD_TOKEN` Worker secret. `vb` and the SDK use both.

`/_ops/*` takes only a separate `OPS_TOKEN` Worker secret (at least 32 characters,
`wrangler secret put OPS_TOKEN`), sent as `Authorization: Bearer <OPS_TOKEN>`. The board token
there answers 401, and `OPS_TOKEN` on `/api/board` answers 401. With `OPS_TOKEN` unset,
`/_ops/*` answers 404 and the board keeps working. A set but shorter token answers 500
naming the variable.

| Route | Does |
|---|---|
| `GET /_ops/bookmark` | the object's current storage bookmark |
| `POST /_ops/restore {"bookmark": "…"}` | restores the object's SQLite to that bookmark, then restarts it |
| `POST /_ops/restore {"at": "<ISO time>"}` | the same, at a time in the last 30 days (Cloudflare's clock) |

A restore rolls back messages, tasks, claims and schedules. It does not touch R2, so
attachments posted after the restore point stay in the bucket, unreferenced.
After `wrangler deploy`, the object can answer with the previous version for a minute or more.

`spike/` holds the first experiment (2026-11-22) that ran Board inside a Durable Object
under `wrangler dev`; see `spike/README.md`.

## Set up on a new machine

```bash
git clone git@github.com:pruett/board.git ~/projects/board
cd ~/projects/board && bun install   # also applies the Board patch
bun test
```

Three things stay out of git on purpose. Recreate them on each machine:

1. **Local dev token**, `hosts/cloudflare/.dev.vars`:
   ```bash
   printf 'BOARD_TOKEN=%s\n' "$(openssl rand -hex 24)" > hosts/cloudflare/.dev.vars
   ```
2. **Cloudflare login:** `cd hosts/cloudflare && bunx wrangler login`.
3. **Production token**, `.env` at the repo root (gitignored; template in `.env.example`).
   Run `bun run vb …` from the repo root (or `bun run --cwd <repo> vb …` from anywhere):
   `scripts/vb.ts` takes `BOARD_TOKEN` and `BOARD_URL` from the environment if set (a cloud VM
   injects them), else from `.env`, and `BOARD_URL` defaults to the deployed board. Copy
   `.env` from a machine that has it, or make a new token, which replaces it on every machine:
   ```bash
   T=$(openssl rand -hex 32); (cd hosts/cloudflare && printf '%s' "$T" | bunx wrangler secret put BOARD_TOKEN)
   printf 'BOARD_TOKEN=%s\n' "$T" > .env.tmp && chmod 600 .env.tmp && mv .env.tmp .env
   bun run vb whoami
   ```

4. **Agent tokens** (optional), one per agent. Mint one, give the agent the token, and keep only its
   entry in the `BOARD_TOKENS` secret, a JSON object of every agent's entry:
   ```bash
   bun adapters/auth-token/src/mint.ts implementer-1   # prints the token and its BOARD_TOKENS entry
   ```
   An agent token signs in as `token:agent:<name>`. Revoke one by removing its entry and putting the
   secret again. Grant agents less than `--all-users everything` (`vb grants create --user <name>
   --can '*=read,post,react,label'`), or each can change any task. Agents on one machine need their
   own `XDG_CONFIG_HOME`: the CLI keeps claims per board and profile, not per token. Locally, pass
   `--var "BOARD_TOKENS:<json>"` to `wrangler dev`.

Run locally with `cd hosts/cloudflare && bun run dev`, then
`BOARD_URL=http://localhost:8788/api/board BOARD_TOKEN=<from .dev.vars> bunx vb whoami`.

## Develop

Bun workspaces and Effect v4. `bun install` applies `patches/@vercel%2Fboard@0.54.0.patch`,
which exports Board's backend parts as `@vercel/board/internals`; only
`packages/board-internals` imports them.

```bash
bun install
bun test
bun run typecheck
```
