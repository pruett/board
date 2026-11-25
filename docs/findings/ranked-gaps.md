# Ranked gaps: today's board to Fleet v2

Merged from `arch-gaps.md`, `mock-friction.md` and `runbook-friction.md`, re-checked against
`main` at `c71cf1478`. Ranked by how much each blocks Fleet v2 (agents with their own
identities on one cloud board that any machine can join). "Wave 1" = already being built.

Who: **agent** = a worker agent, **operator** = the person running the board, **user** = a
person reading or writing on the board. Size: S = under a day, M = a few days, L = a week or more.
"The one storage unit" is the Cloudflare Durable Object that holds the whole board.

| # | What breaks | Who it hurts | Where (current) | Size |
|---|---|---|---|---|
| 1 | One token means every caller is the same person. Agents only say who they are with a name in `x-board-profile`, which is not checked, so `claim --ready` and `reopen` take other agents' tasks. Grants can never match a caller. (Wave 1: per-agent tokens.) | agent, operator | `adapters/auth-token/src/index.ts:4`, `:55`; name unchecked: `node_modules/@vercel/board/dist/actors-D-u6bitG.mjs:16-35` | L |
| 2 | The board token also restores the whole database to any time in the last 30 days. (Wave 1: separate operator token.) | operator, user | `hosts/cloudflare/src/index.ts:87-93`; `hosts/cloudflare/src/ops.ts:2-3`, `:40` | S |
| 3 | No copy of the data outside the storage unit. Restore reaches back 30 days only and does not roll back R2, so files can be orphaned. Decided: event-log to R2 plus nightly snapshot. | user, operator | `README.md:34`, `:45`, `:47-48`; `hosts/cloudflare/src/ops.ts:6`; upload is two R2 puts: `node_modules/@vercel/board/dist/local-RoMUU6QX.mjs:6656-6661` | L |
| 4 | Failed writes come back as 503 and the SDK does not retry. A post or claim can fail with no retry. The board itself answers 503 after 10 lost write races. | agent | SDK throws on any non-2xx: `node_modules/@vercel/board/dist/errors-DDfXnZ2b.mjs:1266-1282`; 503 after 10 races: `dist/local-RoMUU6QX.mjs:5651-5661` | S |
| 5 | Every request goes to one storage unit, so one instance's speed and location bound all agents. No split by channel or team. | agent, user | `hosts/cloudflare/src/index.ts:26`, `:93` | L |
| 6 | Live streams (`vb tail`, `fleet watch`) keep the unit awake. Each open stream runs a poll of the event table every 25 ms when busy, 2 s when idle. Streams end after 280 s. | operator (cost), agent | `node_modules/@vercel/board/dist/exports-JUhj5Bl3.mjs:5353`, `:6211`; `dist/store-sqlite-D6fIszST.mjs:968-976` | M |
| 7 | Reads right after a write can miss it: the table copy may lag and a post answers after 10 s anyway. Catch-up work only runs while the unit stays awake; the background-work hook is set by Vercel's request context, which Cloudflare does not set (untested). | agent | `dist/local-RoMUU6QX.mjs:5609-5614`; `dist/local-RoMUU6QX.mjs:238-249` | M |
| 8 | One consumer that fails 10 times is dead-lettered. Reads by message ID then fail until someone redrives it, and there is no route or tool to do that. | agent, operator | `dist/local-RoMUU6QX.mjs:1629`, `:3058`, `:6831-6839` | M |
| 9 | Failed timers retry forever (5 s doubling to 10 min) and run one at a time, so one slow timer delays the rest. The error text is saved but nothing reads it. | agent (timers, claim leases), operator | `adapters/scheduler-alarm/src/index.ts:40`, `:142-155` (error saved at `:151`) | S |
| 10 | A restore loses writes made in the 50 ms before the restart. | user (silent loss) | `hosts/cloudflare/src/ops.ts:51` | S |
| 11 | A bad token setting makes every request return 500, not just auth. | operator | `adapters/auth-token/src/index.ts:16-18`; `hosts/cloudflare/src/index.ts:47-49` | S |
| 12 | Attachments are capped at 4 MB. No upload URL, so large files cannot be sent. | agent, user | `adapters/blob-r2/src/index.ts:29-30`; `node_modules/@vercel/board/dist/profile-header-O8wC8yk8.mjs:3` | M |
| 13 | `renew` without `--lease` resets the lease to 15 min, not the claim's own lease, which delays failover. | agent (leaders) | `node_modules/@vercel/board/dist/local-RoMUU6QX.mjs:7482`, `:8217` | S |
| 14 | Agents cannot be narrowed from the CLI. The `x-board-can` limit exists only in the SDK; the CLI's only `--can` is for `grants create`. Grants cannot be checked for real with one token. | agent, operator | `node_modules/@vercel/board/dist/main-B_gzTjBR.mjs:1901` (grants only) | S |
| 15 | Private channels refuse the one token's owner, and the lockout hint does not say how to name yourself. | operator | `adapters/auth-token/src/index.ts:55` (owner returned as `person`) | S |
| 16 | Scripts get bad output: `post` prints mention lines after the ID on stdout; no-ops exit 0; plan keys are not stored; grants are not idempotent and read back in another shape. | agent (scripts) | CLI behavior, `node_modules/@vercel/board/dist/` (not re-pinned) | S |
| 17 | A waiter on `board.task=ready` wakes when the task is claimed, not when it becomes ready. | agent | `node_modules/@vercel/board/docs/04-reference/01-cli.md` (Filters) | S |
| 18 | A stale holder is told to claim again while another holds the task. An agent that follows the hint loops. | agent | runbook item 1 (CLI text, not pinned) | S |
| 19 | Each Board upgrade breaks the patch: it exports hashed file names and edits the message log in place. | operator | `patches/@vercel%2Fboard@0.54.0.patch:7-11`, `:26-32` | M |

**Dropped as low impact for Fleet v2:** arch 18 (audience check; the token scheme ignores it),
mock 5, 7, 8, 11, 18, 19 to 22 (inspector screenshots, banner noise, dev reset, route docs),
runbook 2 to 8 (doc wording and dev setup).

**Stale refs fixed:** arch 1 moved from `index.ts:29-30` to `:26`/`:93`; arch 5 from `auth-token:16-20`
to `:4`/`:55`; arch 6 and 17 moved to `index.ts:87-93` and `ops.ts:51`; arch 9 moved to
`scheduler-alarm:40`/`:142-155`; arch 15 to `blob-r2:29-30`; arch 16 is no longer a constructor
throw, it is a kept start-up failure that answers 500 (`index.ts:47-49`).

**How checked:** `sed -n 'Np' FILE` on every `file:line` above (the `node_modules/@vercel/board/dist/`
ones resolve from the worktree). Item 14: `grep -rn '"--can"' node_modules/@vercel/board/dist/`. Docs paths from `mock-friction.md` are under `node_modules/@vercel/board/docs/`, not
`docs/`. Dist line refs were checked for existence and a sample of their text, not re-read in full.
