# Architecture gaps and surprises — board on Cloudflare (step 3)

Found while writing `docs/architecture/` in the worktree
`/Users/kevinpruett/Projects/personal/worktrees/board/agent-board-arch` (branch
`kevinpruett/agent-board-arch`, base `250d165`). Repo paths are relative to that worktree;
`dist/…` means `node_modules/@vercel/board/dist/…` (Board 0.54.0 with our patch applied).
Ordered by how much each matters for a "distributed board".

## Gaps for a distributed board

1. **One Durable Object holds the whole board.** The Worker sends every request to the object
   named `board` (`hosts/cloudflare/src/index.ts:29-30`, `hosts/cloudflare/src/index.ts:68`).
   All channels, tasks, timers and live streams share one object, so one instance's CPU and one
   location bound throughput and latency for every agent. No sharding by channel or team.
   (Single-threaded execution per object is Cloudflare platform behavior, not shown in this repo.)

2. **No copy of the data outside the object.** Off-object backup and replay are "not yet"
   (`README.md:34`). Point-in-time restore reaches back 30 days only (`README.md:45`,
   `hosts/cloudflare/src/ops.ts:6`) and lives in the same Cloudflare storage it restores. Losing
   the object, or a bad write noticed after 30 days, has no recovery path.

3. **Restore and R2 disagree.** A restore rolls SQLite back but not R2 (`README.md:47-48`); an
   upload writes bytes then metadata as two separate R2 puts, outside any SQLite transaction
   (`dist/local-RoMUU6QX.mjs:6656-6661`). Result: orphaned files after a restore, and a crash
   between the two puts leaves bytes with no metadata. Nothing cleans them up.

4. **Live streams keep the object awake and poll SQLite.** SSE streams run up to 280 s
   (`dist/exports-JUhj5Bl3.mjs:5353`), with a ping every 15 s (`dist/exports-JUhj5Bl3.mjs:6211`),
   and the waiting itself is a loop querying `a2_events` every 25 ms, slowing to 2 s when idle
   (`dist/store-sqlite-D6fIszST.mjs:968-976`, `dist/internal-CvsrprnU-CEPOUpAv.mjs:167-170`,
   `dist/store-polling-BZt2Rf3D-oh3aU_An.mjs:124-129`). Every open `vb tail` / `fleet watch` is
   billed duration plus SQLite reads, all inside the one object. Spike flagged it
   (`spike/README.md:59-60`); no hibernating-WebSocket path exists.

5. **One shared token, one person.** Every caller with the token is the same principal
   (`adapters/auth-token/src/index.ts:16-20`). The agent's name is whatever the client puts in
   `x-board-profile`, unverified (`dist/actors-D-u6bitG.mjs:16-35`,
   `dist/errors-DDfXnZ2b.mjs:1263`). No per-agent or per-machine revocation, no read-only token,
   and rotating means replacing the token on every machine (`README.md:69-76`). Board's
   per-channel `access` rules can't tell agents apart under this scheme.

6. **The board token can roll back the whole database.** `/_ops/restore` uses the same bearer
   token as normal board calls (`hosts/cloudflare/src/ops.ts:1-3`,
   `hosts/cloudflare/src/index.ts:66-67`). Any agent holding the token can restore to any point
   in the last 30 days.

7. **The SDK does not retry ordinary calls.** `raw` throws on any non-2xx, including 503 and
   network errors (`dist/errors-DDfXnZ2b.mjs:1266-1282`); only the events stream reconnects
   (`dist/errors-DDfXnZ2b.mjs:1789-1825`). Board itself can answer 503 when a conditional write
   loses 10 races (`dist/local-RoMUU6QX.mjs:5651-5661`) or the store is unavailable
   (`dist/errors-DDfXnZ2b.mjs:1947-1950`). Fleet's callers must retry themselves, with
   idempotency keys for posts and the claim token for claims.

8. **A poison event can stall reads.** a2 dead-letters a consumer's event after 10 failures
   (`dist/local-RoMUU6QX.mjs:1629`, `dist/local-RoMUU6QX.mjs:3470-3479`); anything that then waits
   for that consumer throws `CONSUMER_DEAD_LETTERED` (`dist/local-RoMUU6QX.mjs:3058`). Reads by
   message ID wait for the tables consumer that way (`dist/local-RoMUU6QX.mjs:6831-6839`). If the
   tables consumer ever dead-letters, reads by ID fail until someone redrives it, and we have no
   route or tool for redrive.

9. **Failed alarm jobs retry forever, serially.** A failing row backs off to 10 min and is never
   dropped (`adapters/scheduler-alarm/src/index.ts:14-15`, `adapters/scheduler-alarm/src/index.ts:69-73`);
   `last_error` is stored but nothing reads it. One alarm runs every due row one after another
   (`adapters/scheduler-alarm/src/index.ts:62-76`), so one slow drain delays every other timer.
   No metric or route shows the backlog.

## Surprising design choices

10. **Background work assumes the object stays alive.** a2 hands background promises to
    `waitUntil` from Vercel's request context (`dist/local-RoMUU6QX.mjs:238-249`); nothing on Cloudflare
    sets that context (my inference, not tested), so the call does nothing. Catch-up work (tables, schedule arming,
    `dist/local-RoMUU6QX.mjs:6801-6807`, `dist/local-RoMUU6QX.mjs:7325-7341`) runs only while the
    object happens to stay up. The alarm rows cover timers, but an in-flight catch-up is simply
    restarted by the next request.

11. **Every write can add a scheduler row and an alarm write.** An external append that leaves
    consumer work pending asks for a watchdog drain (`dist/local-RoMUU6QX.mjs:2068-2069`,
    `dist/local-RoMUU6QX.mjs:1951-1963`), which our scheduler stores as a row and may re-arm the
    alarm (`adapters/scheduler-alarm/src/index.ts:79-85`). Dedup by session and time slot keeps it
    bounded (`adapters/scheduler-alarm/src/index.ts:25-27`), but it is write amplification on the
    hot path worth measuring.

12. **Log and tables commit separately.** The log append and the table write are two
    transactions (`dist/local-RoMUU6QX.mjs:5416`, `dist/local-RoMUU6QX.mjs:5595-5611`). If the
    tables fall behind, a post waits up to 10 s and then answers anyway
    (`dist/local-RoMUU6QX.mjs:5609-5614`), so a reader right after can briefly miss it. Correct by
    design (the log is the truth), but surprising.

13. **`renew` without `--lease` resets to 15 minutes**, not the claim's original lease
    (`dist/local-RoMUU6QX.mjs:7482`, `dist/local-RoMUU6QX.mjs:8217`). A 2-minute leader lease
    silently becomes 15 minutes if one renew forgets the flag, delaying failover. Lease cap is
    1 h (`dist/local-RoMUU6QX.mjs:7437`).

14. **We depend on Board's bundle file names.** The patch exports from hashed chunk names
    (`patches/@vercel%2Fboard@0.54.0.patch:7-11`) and edits a2's `tx` in place
    (`patches/@vercel%2Fboard@0.54.0.patch:26-32`). Any Board upgrade breaks the patch; a2 is
    `experimental-a2` 0.24.0 bundled inside Board
    (`dist/local-RoMUU6QX.mjs:22`).

15. **Attachments are capped at 4 MB** because `blob-r2` has no `uploadUrl`
    (`adapters/blob-r2/src/index.ts:15-16`, `dist/profile-header-O8wC8yk8.mjs:3`,
    `dist/local-RoMUU6QX.mjs:6697-6699`).

16. **A bad token config takes the whole board down.** `tokenAuth` throws in the object's
    constructor for a token under 32 characters or a malformed owner id
    (`adapters/auth-token/src/index.ts:11-15`, `hosts/cloudflare/src/index.ts:49`), so every
    request fails rather than just auth.

17. **Restore restarts the object with a 50 ms timer** after answering
    (`hosts/cloudflare/src/ops.ts:22-24`). Requests that arrive in those 50 ms still hit the old
    database, and writes made then are lost by the restore.

18. **Audience check needs `BOARD_PUBLIC_URL`.** Without it Board checks tokens against the
    request's Host, and refuses with 500 when `NODE_ENV=production`
    (`dist/exports-JUhj5Bl3.mjs:5381-5387`). The deploy sets it (`hosts/cloudflare/wrangler.jsonc:17`)
    but the host treats it as optional (`hosts/cloudflare/src/index.ts:25-26`,
    `hosts/cloudflare/src/index.ts:47`). Low impact with our token scheme, which ignores audience.
