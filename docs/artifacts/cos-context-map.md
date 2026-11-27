# CoS context map (fleet v1)

Source: Claude artifact "CoS Context Map" (https://claude.ai/artifact/8BYCRU6oTYXxecM2rGTBzU), 2026-11-10, copied 2026-11-27.
Measured on fleet v1's Chief of Staff. Relevant to v2 because k2, leads and workers still start as `claude` and pay the same boot cost per run; with a fresh agent per event, that cost now repeats on every event.

What the Chief of Staff carried in its context, stage by stage. Totals are measured from one CoS session (transcript `0a622551`, 10 Nov). The split inside each total is an estimate (bytes ÷ 4).

| | Tokens |
|---|---|
| Before it does anything (boot) | 45.8k |
| After its first turn | 66.8k |
| After 13 turns | 77.9k |
| After first turn, with all four cuts below | ~38k (estimate) |

## Stages

1. **Launch** (`cos up` → `hc run chief-of-staff`): 0 tokens.
2. **Program** (`cos exec` starts `claude` with the user's whole setup via `CLAUDE_CONFIG_DIR`): 0 tokens.
3. **Boot / first prompt**: tool definitions, system prompt, skill and agent lists, first MCP connectors, CLAUDE.md, the start task: **45.8k**.
4. **First turn**: reads SKILL.md, `ceo.md`, `cos status`; most claude.ai connectors finish connecting and add 583 tool names: **+21.0k → 66.8k**.
5. **Steady state** (inbox loop, lead reports, `gh pr view`, `hc read`): **+11.1k over 11 turns**.
6. **Every lead and worker** pays the same ~45k boot.

## Where the boot tokens go (estimates, k tokens)

| Part | Boot | Turn 1 |
|---|---|---|
| Built-in tool definitions | 20.0 | |
| Claude Code system prompt | 2.4 | |
| Skill list (44 skills) | 4.8 | |
| Agent types list | 1.3 | |
| MCP connector tools and instructions | 2.0 | +8.7 |
| CLAUDE.md, output style, environment | 1.1 | |
| CoS's own files and messages | 0.5 | +2.5 |
| Not broken down | 13.7 | +9.8 |

## Cuts for the CoS only (flags in its launch args)

| Cut | Flag | Saves |
|---|---|---|
| Drop MCP connectors (712 tool names: Vercel 252, Statsig 93, Linear 78, …) | `--strict-mcp-config` (verify claude.ai connectors drop too) | ~10.7k |
| Remove tools it never uses (the Artifact tool alone is ~9.6k) | `--disallowedTools Artifact Workflow SendFeedback ScheduleWakeup ReportFindings ShareOnboardingGuide` | ~14.5k |
| Hide the skill list | `--disable-slash-commands` (after its rules are in the system prompt) | ~4.8k |
| Remove the subagent tool | `--disallowedTools Agent` | ~2.5k |

## Smaller fixes

- Fold the role template into the system prompt instead of a turn spent reading SKILL.md; pass the task as Claude's prompt argument.
- Don't repeat the start steps in both the start task and SKILL.md.
- `hc --skill` (18 KB, ~4.6k tokens) was required but skipped; drop the line or inline the few commands.
- The user's personal CLAUDE.md rules ("3 sentences", "make an HTML page") reach the CoS; say they don't apply.
- Memory split across two folders because the state dir is a symlink; launch with the resolved path.
