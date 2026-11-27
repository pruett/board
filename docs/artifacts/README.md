# Artifacts and handoff

Claude artifacts made for this project, copied here as Markdown on 2026-11-27 so they survive a change of Claude account. The files here are the source now; the original links work only in the old account.

| File | What | Original |
|---|---|---|
| [fleet-v2-decisions.md](fleet-v2-decisions.md) | **The decision log**: organization, orchestration, labels, landing work, identity, backup, open items | https://claude.ai/artifact/17WcphMLcpcYbjcbRtusGs |
| [board-persistence-map.md](board-persistence-map.md) | Where the board's data lives, failure table, backup layers, the four persistence decisions | https://claude.ai/artifact/6ZhnSS1PCuR7x3tHYjgQQY |
| [board-primitives-map.md](board-primitives-map.md) | Board's model, identity terms, how agents talk, ranked gaps (2026-11-24) | https://claude.ai/artifact/Nm4W561nfosUaPSUCPnV1C |
| [fleet-v1-walkthrough.md](fleet-v1-walkthrough.md) | The file-based fleet design v2 replaces | https://claude.ai/artifact/BvHNSJcs8sheyKPgvgzYvy |
| [cos-context-map.md](cos-context-map.md) | Token cost of a fleet agent's boot, and flags that cut it | https://claude.ai/artifact/8BYCRU6oTYXxecM2rGTBzU |
| `docs/architecture/` | Was also published as "Board Architecture" (https://claude.ai/artifact/PUkytybXXrvoVYtxoUwict); the repo pages are the source | — |

## Notes for the next agent (from the old machine's Claude memory)

The old Mac's Claude Code memory doesn't travel; these are its points that aren't recorded elsewhere in the repo.

- **Use case.** pruett (CEO) built `fleet` (Captain → leads → workers, one-way, file inbox) by hand; its inbox works poorly. Board is the replacement messaging layer, human↔agent and agent↔agent. Agents keep typed roles with their own identities. Board stays agnostic to roles.
- **Goals (2026-11-25).** Fleet v2 on Board; this project's own work is coordinated on the deployed board; identity first. Later: rerun the Lumen mock (`examples/mock-project/` in the agent-board project) with real per-agent identities.
- **Toolchain.** Bun + TypeScript + Effect. Use what that gives (Bun's `.env` loading, `bun run` scripts, TS, Effect) before bash wrappers or new tools (mise and a bash `bin/vb` were rejected). Ask before stepping outside it.
- **PRs.** One PR per branch, titled `1/N …` when ordered by dependency, short summaries. Merge docs, infra and cleanup yourself; for now pruett also said to merge everything else. Deploys, secrets, `/_ops` and token rotation always need pruett.
- **Watching.** Run work through the board (hq + project channels) so pruett can watch it; `bun run vb inspect --port 4800` opens a local viewer.
- **Answer style** (pruett's global CLAUDE.md, also on the new machine if the dotfiles are): short answers, name file:line and commands, plain words, a small diagram or page for anything with more than 3 moving parts.

## State on 2026-11-27

- main has PRs #1–#11 (ops token, agent tokens, gaps report, R2 design, `bun run agent`, review fixes). `bun test` 116 pass, typecheck clean.
- The deployed board (`board.pruett.workers.dev`) still runs the code from before PR #1. Its data (hq #421–#434 drafts, fleet2, wave 1 history) is there and reachable from any machine with `BOARD_TOKEN`.
- The board token lives only in the old Mac's repo `.env`. Copy it over, or mint a new one (README, "Set up on a new machine"), which logs out every other machine.
- Open items: see the end of `fleet-v2-decisions.md`.
