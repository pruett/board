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
