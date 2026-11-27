# Fleet (v1): the CoS, leads and workers end to end

Source: Claude artifact "Fleet Walkthrough" (https://claude.ai/artifact/BvHNSJcs8sheyKPgvgzYvy), 2026-11-12, copied 2026-11-27.
This is the **file-based fleet design that Fleet v2 replaces** with the board; kept for what carries over (roles, PRD alignment, one writer per file). In v2 the CoS is k2, the inbox/queue/leases are board tasks and claims, and agents start through `bun run agent`, not `hc`.

A worked example of the proposed design. **Fleet** is the system: one CLI, one state folder, one skill. The **Chief of Staff (CoS)**, **lead** and **worker** are roles inside it. The CoS passes messages between the CEO and the leads, and the leads do the work.

## Two layers

| Layer | What it is | Named |
|---|---|---|
| System | The CLI, the state folder, config, env vars, the panel, the `/fleet` skill | `fleet`, `FLEET_*`, `~/.local/state/fleet` |
| Roles | A prompt file plus program and model settings in `roles.json` | `cos`, `lead`, `implementer`, `researcher`, `tester`, `reviewer`, `cloud-agent` |

Agents keep their role names as their hc names: `cos`, `lead-<p>`, `<p>-<role>-<slug>`.

## Where things live

- **`~/.agents/skills/fleet/`**: `SKILL.md` (`/fleet`), `scripts/fleet` (the CLI), `roles.json`, `roles/cos.md` (~40 lines), `roles/lead.md` (~60), `roles/worker.md`, `references/` (`prd.md`, `briefs.md`, `principles.md`, `gotchas.md`).
- **`~/.local/state/fleet/`**: `config.env` (`FLEET_WORK_ROOT`, `FLEET_CLAUDE_CONFIG_DIR`), `playbook.md` (rules, accounts, machine notes; loaded into every CoS and lead prompt), `inbox/`, `queue/`, `projects/`.
- **Env set by `fleet exec`**: `FLEET_HOME`, `FLEET_WORK_ROOT`, `CLAUDE_CONFIG_DIR`, `FLEET_ROLE`, `FLEET_PROJECT_DIR` (leads and workers).

## Project files (`$FLEET_HOME/projects/<p>/`, each with one writer)

```
brief.md       ← CLI writes the CEO's words; only dated additions after that
project.md     ← the lead writes it
  ## PRD              (the CoS signs it, then it stays fixed)
  ### Goal · Done when · Repos · Worktrees · Scope · Verification
  ## Standing orders  project rules beyond playbook.md, current state only
  ## Now              the resume point: workers in flight, what's waited on, the next step
  ## Plan · Stuck · Done
decisions.md   ← append-only log: date, decision, who, why
project.json   name, lead, status (aligning | active | closed), PRD hash
briefs/  reports/  evidence/  drafts/
```

## Who may run what

| Command | You (/fleet) | CoS | Lead |
|---|---|---|---|
| fleet up | yes | — | — |
| fleet project new \| approve \| goal \| close | yes | yes | — |
| fleet inbox [--wait \| --done] | read | yes | — |
| fleet forward &lt;id&gt; | — | yes | — |
| fleet report --kind prd\|done\|stuck\|fyi | — | — | yes |
| fleet ask (as a draft) | — | — | yes |
| fleet run \| ls \| stop \| handoff | — | — | yes |

## Walkthrough: "compare-page"

0. **CEO types `/fleet`**: loads the skill, runs `fleet --help` and `fleet status`, asks what to do.
1. **`fleet up` starts the CoS in HQ**: reads `config.env` and `roles.json`; `hc run --bg --no-parent --keep --name cos … -- fleet exec cos "Start your shift."`; the CoS runs `fleet status`, `fleet queue`, then `fleet inbox --wait`.
2. **CEO: "start a new project that adds a side-by-side compare page"**: the CoS runs `fleet project new compare-page --brief "…"`. The CLI writes `brief.md`, `project.md` (PRD fields `TBD`), `decisions.md`, `project.json` (`aligning`), and starts `lead-compare-page`.
3. **The lead drafts the PRD**: each field answered with its source, or `TBD: question — rec: answer`; then `fleet report --kind prd`. `fleet run` is refused while aligning.
4. **Alignment (only when a field is TBD)**: the CoS answers from `playbook.md` or `brief.md`, else asks the CEO; the lead edits and reports again.
5. **The CoS signs**: `fleet project approve` checks no field says TBD, sets `active`, stores the PRD hash, logs it, tells the lead to start.
6. **Work**: the lead makes worktrees and runs `fleet run implementer|reviewer|tester …`, refused unless active and the PRD hash matches. Questions: answered by playbook/PRD/standing orders/decisions → the lead decides and logs it; otherwise `fleet ask` → the CoS forwards or answers. Scope change: `fleet project goal` → back to aligning.
7. **Done**: `fleet report --kind done`, a review item with the PR and screenshots; the CoS forwards; on approval the lead merges; `fleet project close` stops the lead and its workers and keeps the files.

## The lead role

The CoS stays a broker, so the effort goes into the lead. Lessons from `function-mam-mint-web`: the lead's context filled up and the CoS wrote handoff files by hand; one PR's merge permission changed four times in `decisions.md`, so a new lead had to reconstruct the current rule.

`roles/lead.md` outline:

```
1. You           own one project; the CoS is upstream, workers downstream
2. Messages      CoS (hc) · workers (hc) · the CEO typing in your pane
3. Aligning      fill the PRD → fleet report --kind prd → wait for approval
4. The loop      chunk → pick a role → brief → fleet run → collect → verify → accept → fleet stop
                 verify = cross-family reviewer on every diff, tester + screenshots on anything user-visible
5. Deciding      playbook, PRD, Standing orders or decisions.md answer it → decide, log it
                 otherwise → fleet ask (draft) with your recommendation, keep working
6. Reporting     fleet report --kind done|stuck|fyi; the five-line format
7. Staying fresh keep Now current; at ~60% context, fleet handoff
8. Lines         playbook's "Always ask me", plus no worker starts agents of its own
```

| Role | Runs | Prompt | For |
|---|---|---|---|
| cos | claude, Opus, low effort | roles/cos.md + playbook | message broker |
| lead | claude, Opus | roles/lead.md + playbook | one project |
| implementer | claude, Opus | roles/worker.md | code, in its own worktree |
| researcher | claude, Haiku | roles/worker.md | read-only questions |
| tester | claude, Sonnet | roles/worker.md | runs the app, screenshots |
| reviewer | codex, gpt-6.1-sol | roles/worker.md | second-family review |
| cloud-agent | devin-as &lt;company&gt;, cloud | roles/worker.md | long jobs that must survive the Mac going offline |
