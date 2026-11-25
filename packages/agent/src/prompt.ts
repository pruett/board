import type { Role } from "./roles.ts"

export interface PromptInput {
  readonly profile: string
  readonly role: Role
  /** The repo root `vb` runs in. */
  readonly repo: string
  readonly taskId: string
  /** The hq thread with the rules every worker follows (kind=role role=worker). */
  readonly rulesId: string
  /** The hq thread for this role (kind=role role=<role>). */
  readonly roleId: string
}

/** The whole prompt a fresh agent starts with: who it is, how to write, and where its context is on the board. */
export const buildPrompt = (p: PromptInput): string =>
  `You are ${p.profile}, a ${p.role}. Board writes: bun run --cwd ${p.repo} vb <command> --as ${p.profile}. ` +
  `You already hold task #${p.taskId} (claimed for you; renew it with vb tasks renew ${p.taskId} --as ${p.profile} before each 15 min lease ends). ` +
  `Read #${p.rulesId} (the rules every worker follows), #${p.roleId} (your role), then vb read ${p.taskId} and its whole thread. ` +
  `Follow the brief. Finish with vb tasks complete or vb tasks fail, then exit.`

export interface LeadPromptInput {
  readonly project: string
  readonly repo: string
  /** hq, kind=org: how the organization runs. */
  readonly orgId: string
  /** hq, kind=role role=lead. */
  readonly roleId: string
  /** The project's channel, kind=project: its context, which the lead keeps current. */
  readonly contextId: string
  readonly eventId: string
}

/** The prompt for one lead run: one board event, one turn. */
export const leadPrompt = (p: LeadPromptInput): string =>
  `You are lead-${p.project}, the project lead. Board writes: bun run --cwd ${p.repo} vb <command> --as lead-${p.project}. ` +
  `Read #${p.orgId} (how the organization runs), #${p.roleId} (your role), #${p.contextId} (your project's context: keep it current), ` +
  `then the event: vb read ${p.eventId}. ` +
  `Take ONE turn: blocked -> answer in the thread and vb tasks unblock; completed or failed -> read the result, land or re-plan per the context thread; ` +
  `a goal -> claim it and reply with your plan as tasks in ${p.project}. Then exit.`

export interface K2PromptInput {
  readonly repo: string
  readonly orgId: string
  readonly owner: string
  readonly eventId: string
}

/** The prompt for one k2 run: a lead's question or a message from the owner. */
export const k2Prompt = (p: K2PromptInput): string =>
  `You are k2, chief of staff. Board writes: bun run --cwd ${p.repo} vb <command> --as k2. ` +
  `Read #${p.orgId}, then the event: vb read ${p.eventId}. ` +
  `Answer the lead in its thread (then vb tasks unblock) or act on ${p.owner}'s message. One turn, then exit.`
