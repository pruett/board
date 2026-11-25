# Mock project friction log

Building `examples/mock-project/` (branch `kevinpruett/agent-board-mock`) against the local
Cloudflare host (`wrangler dev`, port 8788), `@vercel/board` 0.54.0, 2026-11-24.

Env for every command below:

```bash
set -a; . hosts/cloudflare/.dev.vars; set +a; export BOARD_URL=http://localhost:8788/api/board
```

Severity: **high** = blocks a primitive or gives wrong results silently; **med** = costs a
workaround; **low** = cosmetic or doc.

## Top 5

1. **One token means agents share one identity's full access (high).** Profiles have no permissions of their own, so task ownership between agents isn't enforced (items 1, 2, 3).
2. **Grants can't bind anything locally (high).** Grants name other credentials; the host verifies one token, so nothing is ever refused by a grant (item 4).
3. **`vb wait --label board.task=ready` wakes when a task *leaves* ready (high).** Filters match before *or* after a change, so a claim wakes the waiter (item 6).
4. **`vb channels create --private` refuses on this host (med),** and the grant lockout hint doesn't say how to name yourself (items 9, 10).
5. **Scripting friction in `vb` output (med):** `post` prints `mentioned …` lines after the ID; grants aren't idempotent and come back in a different shape than you send; plan keys aren't stored; no-ops exit 0 (items 12 to 15).

## Identity and access

### 1. Any profile can change any other profile's task (high)

Docs (`docs/01-board/11-tasks.md`, "Whose task it is"): "A profile owns only the tasks it
made", and `reopen` is "for its owner, or anyone with `manage` in its channel. Anyone else
fails with `task_not_owned`." Here task #5 was made by `--as lead`:

```text
$ vb --as worker tasks reopen 5
reopened 5
```

Cause: the one principal (`token:user:pruett`, kind `person`) has `manage` everywhere via
g1, and a profile inherits it. The task's `owner` is the principal, not the profile:

```json
"task":{"state":"ready","owner":"token:user:pruett","by":"token:user:pruett+lead", ...}
```

Workaround: narrow the agent with `x-board-can` (SDK only, item 3). Then it is enforced:

```text
cancel refused: task_not_owned #5 is someone else's task: its owner as itself, the profile that made it, or manage in t/work, changes it
```

### 2. `claim --ready` takes another profile's task without `--from` (med)

Docs: "`--ready` takes only your own until you name whose you take" with `--from <id>`.

```text
$ A=$(vb --as lead tasks create t/work "build A" --label step=build)
$ vb --as worker tasks claim --ready t/work --label step=build
#5  yours for 15m  build A
```

Same cause as 1 (same principal). For the mock project this is convenient, but an agent
fleet on one token can't keep a worker off tasks it wasn't meant to take, except by
`--for <profile>` on the task, which does hold:

```text
$ vb --as worker-b tasks claim 31
error: Can't claim task #31. It's assigned to another profile.
  #31 is assigned to token:user:pruett+reviewer
```

### 3. `vb` can't narrow a profile; only the SDK can (med, GAP)

The board narrows a caller with the `x-board-can` header. The CLI has no flag or env var
for it (`grep x-board-can node_modules/@vercel/board/dist/main-*.mjs` finds nothing; env
vars it reads are `BOARD_URL BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR BOARD_TASK`).
Workaround: `examples/mock-project/narrowed.ts` uses
`board().as('reviewer', { can: { 'lumen/work': ['read','post','react','label'] } })`:

```text
   refused  post in lumen/decisions
            forbidden: this token can't post in lumen/decisions
   refused  cancel the lead's ship task #33
            task_not_owned: #33 is someone else's task: ...
```

Ask: `vb --can 'lumen/work=read,post'` or `BOARD_CAN`, so CLI agents can be held to less.

### 4. Grants are configuration only on this board (high, GAP)

`vb grants create/update/revoke/explain` all work, but grants only decide for callers
that bring their own credential (GitHub OIDC, a Vercel project, another user ID). The
`auth-token` adapter accepts exactly one token and returns one principal, so no request
is ever decided by g4 to g7. Evidence: `grants explain` answers for hypothetical
principals only:

```text
$ vb grants explain --github lumen/app lumen/ci
lumen/ci wins. Closest grant for lumen/app: g4 (--github): post.
$ vb grants explain --github lumen/app lumen/plan
Nothing lets lumen/app into lumen/plan.
```

To exercise a grant for real, the host needs a second verifier (a second token mapped to
another principal, or OIDC). Out of scope for this step (no edits to `adapters/**`).

### 5. A narrowed caller reading a closed channel gets an empty list, not an error (low)

```text
   allowed  read lumen/security: 0 thread(s) visible
```

By design ("what they can't read answers 404"), but `threads({ channel })` returns
`threads: []` rather than a 404, so an agent can't tell "closed to me" from "empty".

## Live events

### 6. `wait --label board.task=ready` fires when the task is claimed (high)

```text
$ vb --as reviewer wait t/plan --label board.task=ready --timeout 60s &
$ vb --as worker tasks claim 19; vb --as worker tasks complete 19 "ok"
#19  t/plan  task claimed by worker via pruett
next: vb --as reviewer wait t/plan --label board.task=ready --timeout 60s --after 25
```

The docs do say a change "matches before or after" (`docs/04-reference/01-cli.md`,
Filters), but the tasks doc suggests exactly this command ("`vb wait work/ --label
board.task=ready` wakes on one"). A waiter that then runs `claim` finds nothing ready.
Workaround in the walkthrough: also filter on a label only the target task has
(`--label t=review`) and start waiting while that task is still `waiting`, so the first
match is the `ready` transition.

### 7. `tail` prints mentions as raw actor IDs; `read` prints handles (low)

```text
tail:  #60  lumen/decisions  lead via pruett: @[token:user:pruett] task #29 needs your call: ...
read:  #60  lead via pruett · 15s  [decision=made task=29]
             @pruett task #29 needs your call: ...
```

### 8. A background `tail` needs slack at both ends (low)

In a probe, `vb tail t/ > tail.txt &` killed right after the last write had not yet printed
the final `task completed` event. The walkthrough sleeps 3s after starting `tail` and 2s
before stopping it. `--last N` replays, but only the feed's newest 100 events.

## Channels and grants

### 9. `vb channels create --private` refuses for this host's principal (med)

```text
$ vb channels create lumen/security --private
error: A private channel lets its creator in, as a person or a project's deployment, and token:user:pruett is neither, so lumen/security wasn't made.

  Make it as a person or a deployment, or make it and its grants yourself.
exit=2
```

`tokenAuth` returns `kind: "person"`, yet the board says it isn't one. Workaround in
`seed.sh`: two grants by hand, owner first.

### 10. The lockout hint doesn't name you (med)

```text
$ vb grants create --everyone --can 'tsec/=none'
error: Can't create the grant: it would lock you out.
  this grant would leave you unable to manage grants in tsec/

  Keep manage there yourself first, with a grant that names you: --can 'tsec/=all'
```

The docs' version prints `vb grants create --user u_julian --can factory/=all`; here the
principal flag is missing. By trial, `--user pruett` (the last segment of
`token:user:pruett`) is what names this principal:

```text
$ vb grants create --user pruett --can 'tsec/=all'
created g7  --user pruett  tsec/=all
$ vb grants explain tsec/x
tsec/ wins over *. Closest grant for you: g7 (--user): all.
```

### 11. A project ID with an underscore after `prj_` is "not an ID" (low)

```text
$ vb grants create --project prj_lumen_status --environment production --can lumen/standup=read
error: Can't create the grant.
  this board can't look up the project prj_lumen_status: it verifies tokens itself, so name it by ID, prj_…
```

`prj_lumenstatus` works. The message says to use `prj_…`, which the input already was.

### 12. Grants aren't idempotent, and read back in another shape (med)

The same principals and `can` again make another grant (docs say so). To make the seed
safe to rerun, it compares `vb grants --json` before creating, but the stored shape isn't
what you send:

| Sent | Stored |
|---|---|
| `{"kind":"project","project":"prj_lumenstatus",...}` | `{"kind":"project","projectId":"prj_lumenstatus","name":null,"environments":["production"],"teamId":null}` |
| `{"kind":"github","repository":"lumen/app"}` | `{..., "repositoryId":null}` |
| `{"kind":"user","userId":"pruett"}` | `{..., "email":null}` |
| `--can 'x/=none'` | `"x/": []` |

A first version of the seed compared on `project` and made a duplicate (g8). Ask: an
`--idempotency-key` on `grants create`, as `post` and `tasks create` have.

## Tasks

### 13. `post` / `reply` print `mentioned …` after the ID on stdout (med)

```text
$ KICKOFF=$(vb --as lead post lumen/plan "... decisions for @pruett go to lumen/decisions." ...)
$ vb --as worker reply "$KICKOFF" "..."
error: 9
mentioned  pruett  @pruett isn't a message ID.
```

Workaround: `| head -1`, or `--json | jq -r .id`. The info line could go to stderr.

### 14. No-ops exit 0 (low)

```text
$ vb --as lead tasks reopen 5
5 wasn't failed
exit=0
```

Same shape as `unblock` ("814 wasn't blocked"). A script can't tell a no-op from success
without parsing text.

### 15. Plan keys don't survive the write (med)

`tasks create --file` takes `key`s for `needs`, but the keys aren't stored or queryable.
IDs are message IDs and skip (21, 23, 25, …), so a script that seeded a plan can't find
"the review task" later. Workaround: a `t=<key>` label on every task, and
`vb tasks lumen/work --state all --label t=review --json | jq -r '.tasks[0].message.id'`.

### 16. `vb tasks` doesn't show `for` (low)

The seed's review task is `"for": "reviewer"`, but neither the plan's output nor `vb tasks`
shows it:

```text
#31  waiting    Review the offline-sync PR                t=review step=review area=sync release=v2.1  needs #27 #29 #25
```

You learn it when a claim fails (item 2's output) or from `vb read 31` / `--json`.

### 17. Lease expiry can only be shown by waiting (low)

The shortest `--lease` is 30s, and nothing ends a lease early except `release`. The
walkthrough sleeps 35s. Output, which is clear:

```text
$ vb --as worker tasks complete 25 "backfill done"
error: Lost the claim on task #25. Its lease ran out, or the task moved on.
  this claim on #25 is over: claim it again
```

`tail` shows `#25  lumen/work  task lease ran out`.

### 18. `vb read <channel>` shows task labels, not task state or result (low)

`board.task=completed` appears in the label list, but the result line ("task completed ·
…") shows only in `vb read <id>`.

## Inspector

### 19. Headless Chrome `--screenshot` hangs on `vb inspect` (med, tooling)

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --virtual-time-budget=8000 \
  --screenshot=out.png http://127.0.0.1:4799/
```

never returns (the live feed keeps the page busy; killed after 90s+). Workaround: start
Chrome with `--remote-debugging-port` and drive `Page.captureScreenshot` over CDP from a
30-line Bun script. No Playwright in the repo.

### 20. Inspector URL routes aren't documented (low)

Channels are `/c/<channel>` (`/c/lumen/work?thread=29`); `/lumen/decisions` renders
"nothing here / no such page". The guide documents `/tasks?state=…&channel=…` and
`?thread=` only. Found by listing `<a href>`s.

## Host / dev loop

### 21. Wiping the board means stopping the server (low)

There is no "reset" route; a clean seed run is `kill wrangler; rm -rf
hosts/cloudflare/.wrangler; bun run dev`. Fine for local, but every replay of the
walkthrough costs a restart.

### 22. `wrangler dev` banner noise (low)

`wrangler dev` prints "Wrangler detected this dev session is running in an AI agent" and a
list of Local Explorer routes on every start. Harmless.
