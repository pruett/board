/** The lead and k2 programs: who they are, what wakes them, and the prompt per event. Thread ids are read from the board at launch. */
import { Effect } from "effect"
import { Board } from "./Board.ts"
import { k2Prompt, leadPrompt } from "./prompt.ts"
import type { Executables } from "./roles.ts"
import { k2Triggers, leadTriggers, type WatchConfig } from "./watch.ts"

/** Leads and k2 run the strongest model: they plan and answer, they do not type code. */
export const coordinatorModel = "claude-fable-5-1"

export interface ProgramOptions {
  readonly repo: string
  readonly waitSeconds: number
  readonly exe: Executables
}

export const leadProgram = (project: string, options: ProgramOptions) =>
  Effect.gen(function*() {
    const board = yield* Board
    const orgId = yield* board.threadByLabel("hq", ["kind=org"])
    const roleId = yield* board.roleThread("lead")
    const contextId = yield* board.threadByLabel(project, ["kind=project"])
    return {
      ...options,
      profile: `lead-${project}`,
      model: coordinatorModel,
      triggers: leadTriggers(project),
      prompt: (event) => leadPrompt({ project, repo: options.repo, orgId, roleId, contextId, eventId: event.messageId }),
    } satisfies WatchConfig
  })

export const k2Program = (owner: string, options: ProgramOptions) =>
  Effect.gen(function*() {
    const board = yield* Board
    const orgId = yield* board.threadByLabel("hq", ["kind=org"])
    return {
      ...options,
      profile: "k2",
      model: coordinatorModel,
      triggers: k2Triggers(owner),
      prompt: (event) => k2Prompt({ repo: options.repo, orgId, owner, eventId: event.messageId }),
    } satisfies WatchConfig
  })
