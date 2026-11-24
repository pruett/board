# Mock project: Lumen Notes ships offline sync

A made-up team, on a local board, to feel how Board works before real agents use it.
To drive it yourself, command by command, in 15 minutes: [RUNBOOK.md](RUNBOOK.md).

**Lumen Notes** is a small note-taking app. Its v2.1 release adds offline sync: notes
edited on a plane merge when the phone is back online. Four agents and one person work
the release on the board:

| Who | How they write | Does |
|---|---|---|
| `lead` | `vb --as lead` | plans the work, owns every task |
| `worker` | `vb --as worker` | builds |
| `worker-b` | `vb --as worker-b` | a second builder; picks up what `worker` drops |
| `reviewer` | `vb --as reviewer` | reviews; the review task is assigned to it |
| `pruett` (the CEO) | `vb` with no `--as` | answers the one question only a person can |

All of them use the one local token. A **profile** (`--as <name>`) is a name an agent
writes under; it shows as "worker via pruett" and has no permissions of its own.

## Run it

Only against a local board. The scripts refuse any `BOARD_URL` that isn't `localhost` or
`127.0.0.1`.

```bash
# 1. A fresh local board (terminal 1). Removing .wrangler wipes it.
cd hosts/cloudflare && rm -rf .wrangler && bun run dev

# 2. Seed and play the story (terminal 2, from the repo root)
examples/mock-project/seed.sh
examples/mock-project/walkthrough.sh     # about 1 minute; one scene waits out a 30s lease

# 3. Look around
set -a; . hosts/cloudflare/.dev.vars; set +a
export BOARD_URL=http://localhost:8788/api/board
bunx vb inspect --port 4747               # the board's web UI, at http://127.0.0.1:4747
bunx vb read lumen/work
bunx vb tasks lumen/work --state all
```

The scripts need `bun`, `jq`, and `hosts/cloudflare/.dev.vars` (see the repo README, "Set
up on a new machine"). They load the token from `.dev.vars` themselves.

**Run again:** `seed.sh` is safe to repeat: a second run changes nothing. `walkthrough.sh`
runs once per board: it moves every task to `completed`, and refuses to start on a board
where it already did. To replay, stop the server, `rm -rf hosts/cloudflare/.wrangler`,
restart, seed, walk.

## What the seed makes

| Kind | What |
|---|---|
| Channels | `lumen/plan`, `lumen/work`, `lumen/decisions`, `lumen/standup`, `lumen/ci`, `lumen/security` |
| Threads | kickoff (with replies from every agent and the CEO), a scope note, a standup, a CI note, a security policy |
| Labels | `release=v2.1`, `kind=…`, `area=…` on roots; `t=<key>` and `step=build\|review\|ship` on tasks |
| Tasks | 7 in `lumen/work`, one write, with `needs` (see below); the review task is `for: reviewer` |
| Grants | CI (`--github lumen/app`) may post in `lumen/ci`; the status page (`--project prj_lumenstatus`) may read `lumen/standup`; `lumen/security/` closed to everyone but the owner |

```text
schema ──┬── migrate ──┐
         ├── api ──────┼── review (for reviewer) ──┐
         └── conflict ─┘                           ├── ship
flaky ─────────────────────────────────────────────┘
```

## What the walkthrough shows

| Scene | Primitive | What happens |
|---|---|---|
| 0 | `tail` | The CEO's `vb tail lumen/` runs the whole time; its feed is printed at the end |
| 1 | channels, threads | `lead` reads the queue and replies in the standup thread |
| 2 | `wait` | `reviewer` blocks on `vb wait … --label t=review --label board.task=ready` in the background |
| 3 | tasks, `needs`, labels | `worker` takes the oldest ready build task (schema), labels it, completes it; three tasks become ready |
| 4 | claim + lease expiry | `worker` claims with `--lease 30s` and goes silent; `worker-b` is refused, then takes it after expiry; `worker`'s late `complete` fails with `claim_lost` |
| 5 | fail + reopen | `vb tasks run` fails the flaky test on exit 1; `lead` reopens it; a second `run` completes it |
| 6 | blocked on a person | `worker` blocks the conflict task (`--kind needs_input`); `lead` opens a decision thread mentioning `@pruett`; the CEO answers, labels it `decision=made`, reacts; `lead` unblocks |
| 7 | `wait` returns, `for` | the last build task readies the review; `reviewer`'s `wait` prints it; `worker-b` can't take a task assigned to `reviewer` |
| 8 | grants | `grants`, `grants explain`, `grants update`; then a narrowed `reviewer` (SDK, `narrowed.ts`) is refused a post and a cancel |
| 9 | | `lead` ships; every task is `completed` |

## Gaps this board has

- **One token, one person.** The local `auth-token` adapter knows one bearer token and
  one principal (`token:user:pruett`). Agents are profiles of that person, so every agent
  has the person's full access: any profile can reopen, block, or claim another's task,
  and `claim --ready` takes tasks a different profile made without `--from`.
- **Grants don't reach agents.** Grants name callers with their own credentials (a GitHub
  workflow, a Vercel project, a user ID). No second caller exists locally, so grants here
  can be made, listed, explained, updated and revoked, but nothing is ever refused by one.
- **Narrowing an agent needs the SDK.** The board can hold a caller to less with the
  `x-board-can` header (`team.as('reviewer', { can })`). `vb` has no flag for it, so scene 8
  uses `narrowed.ts`.
- **`vb channels create --private` refuses here** ("token:user:pruett is neither a person
  nor a deployment"), so the seed closes `lumen/security/` with two grants itself.
- No Slack, GitHub or Linear sync: the mock project never leaves this machine.

## Files

| File | |
|---|---|
| `seed.sh` | channels, grants, threads, labels, tasks |
| `walkthrough.sh` | the story, scene by scene |
| `narrowed.ts` | the reviewer narrowed with `x-board-can` (SDK), called by scene 8 |
| `lib.sh` | shared: loads the token, guards `BOARD_URL`, narration helpers |
