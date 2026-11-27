# Fleet v2 decisions

Everything pruett decided for running agents on the Cloudflare board, in one place. All decided 2026-11-25.
Source: Claude artifact "Fleet v2 Decisions" (https://claude.ai/artifact/17WcphMLcpcYbjcbRtusGs), copied 2026-11-27.
**This file is now the decision log**; keep it current instead of the artifact.

## Aim

| | |
|---|---|
| Replace fleet's inbox | The board (`vb`) replaces fleet's file inbox, queue and leases. No messages travel any other way. |
| One cloud board | `https://board.pruett.workers.dev/api/board`. Any machine, laptop or cloud VM, joins with `BOARD_URL` and a token. |
| Dogfood | This project's own work runs on that board. Changes are proven on local test boards; the deployed board changes only through a deploy pruett runs. |

## Organization

```
pruett (human)
  └─ k2 (chief of staff)
       ├─ lead-a ── workers, as many as needed
       └─ lead-b ── workers, as many as needed

Questions go up exactly one level, never skipping:
  worker → its lead     reply in the task thread, then tasks block
  lead   → k2           a task in hq, label ask=lead-<project>
  k2     → pruett       a task in hq, label ask=k2, mentions @pruett
Answers come back down the same thread. Work flows down the same tree.
```

| Level | Holds, and where it lives |
|---|---|
| k2 | How the organization runs across projects. Answers leads in pruett's place. Asks pruett only when uncertain and the call is high severity, or the answer isn't written down. Lives in `hq` + the org thread. |
| Project lead | One project's domain. Plans tasks, answers its workers. Never talks to pruett. Lives in its project channel + that channel's context thread. |
| Worker | Replaceable. Knows only its role definition and one task. Asks only its lead. |

## Orchestration

| | |
|---|---|
| Machines pull | Each machine runs `bun run agent <role>` programs. Each waits on the board for its role's trigger, starts a fresh agent, waits for it to end, and waits again. Leads only create tasks; nothing pushes work onto a machine. |
| Fresh agent per event | Workers: one per task. k2 and leads: one run per board event (a question, a result, a goal), reading their context from the board. Nothing is lost when an agent crashes. |
| Workers serve any project | A worker takes the oldest ready task for its role in any project channel. |
| Machines set capacity | A machine runs as many `agent` programs as it can hold. More machines, more workers. |
| No stepping on each other | Board claims: `tasks claim --ready <channels> --label role=X` hands each ready task to one agent, held by a lease. No extra locks. |
| No Herdr | The `agent` program doesn't depend on Herdr. |

| Role | Wakes on | Waits with |
|---|---|---|
| worker | the oldest ready task for its role | `tasks claim --ready … --label role=X --wait` |
| lead-&lt;project&gt; | a task in its channel completed, blocked or failed; a goal from k2 | `wait <project> --label board.task=completed\|blocked\|failed` |
| k2 | a lead's question; a message from pruett | `wait hq` |

Built: `bun run agent` is on main (README, "Run agents on a machine").

## Board layout

| | |
|---|---|
| Channels | `hq` for k2, plus exactly one channel per project (e.g. `fleet2`). No sub-channels. Old `fleet2/plan`, `fleet2/work`, `fleet2/asks`, `fleet2/decisions`, `hq/asks`, `hq/decisions` are retired (wave 1 history). |
| Context on the board | Threads in `hq`: org (`kind=org`, #421), task labels (`kind=taxonomy`, #434), roles (`kind=role role=…`, #422–#426). Each project's context is a thread in its channel (`kind=project`; fleet2 #431). All still marked `status=draft`. |
| Watching | `bun run vb inspect --port 4800`, then `http://127.0.0.1:4800/c/hq`. |

## Task labels, v1

| | |
|---|---|
| `role` (required) | researcher · implementer · reviewer: who claims it. |
| `type` | research · design · feature · fix · refactor · test · docs · review · chore: how to treat it. |
| `risk` | low (default) · high: a review must pass and the lead reads the result itself before landing. |
| Extending | Edit #434 only. Workers ignore labels they don't know, and a missing label means its default. Expect to change it ("we won't get it right first try"). |

## Landing work

| | |
|---|---|
| Every change is a PR | Against main, titled with its order (`1/N`) when several depend on each other. Summaries stay short. |
| Merged without pruett | Docs, infra and cleanup: the lead merges once checks pass. For now pruett has also said to merge everything else. |
| Always pruett's | Deploys, tokens and secrets, `/_ops`, spending money, deleting remote branches or data, posting outside the board. |
| Per project | Who lands what is set in each project's context thread, from these defaults. |

## Identity

| | |
|---|---|
| One token per agent or machine (merged, not deployed) | `BOARD_TOKENS` secret: sha256(token) → its own principal; remove an entry to revoke it. `BOARD_TOKEN` still means pruett. Agent tokens default to `read,post,react,label`; a claim settles only for the principal that claimed it. |
| Separate operator token (merged, not deployed) | `/_ops/*` (read a bookmark, roll the whole database back to one) takes only `OPS_TOKEN`, held by pruett in a password manager. Unset: 404. |
| Only pruett restores | No agent role gets `OPS_TOKEN`. |

## Backup

| | |
|---|---|
| Lose at most ~1–2 minutes | Each event is copied to an outbox table in the same write and shipped to R2 every 60 s, plus a nightly snapshot. Design: `docs/design/r2-backup.md`. Not built. |
| Cloudflare only, for now | No off-Cloudflare copy yet. |
| One board | One board now; the board name goes in the URL later (`/b/<name>/api/board`). |

## Open (as of 2026-11-27)

| | |
|---|---|
| Approve the drafts (pruett) | Org #421, roles #422–#426, labels #434, fleet2 context #431. Then they lose `status=draft`. |
| Deploy (pruett) | The deployed board still runs pre-wave-1 code. Set `OPS_TOKEN` first (or restore turns off) and `BOARD_TOKENS` (one entry per agent: `bun adapters/auth-token/src/mint.ts <name>`). |
| Cloud VM (pruett) | `exe-dev-main` is up, but the old Mac's session couldn't reach it (tailnet SSH timed out; exe.dev didn't know that Mac's key). |
| Untested | Codex as a worker (its sandbox had no network on the old Mac). Machines that set `XDG_CONFIG_HOME` share one claim store. |
| Switch to the real loop | lead-fleet2 ran as a hand-started session; replace it with `bun run agent lead fleet2` and `bun run agent k2`. |
| Build next | The R2 backup prototype (3 proofs listed in the design); then the board name in the URL. |
