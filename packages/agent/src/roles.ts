/** Which coding agent each worker role runs, and the argv that starts it. Same values as the role threads in hq. */

export const roles = ["researcher", "implementer", "reviewer"] as const
export type Role = (typeof roles)[number]

export const isRole = (value: string): value is Role => (roles as ReadonlyArray<string>).includes(value)

export interface AgentChoice {
  readonly kind: "claude" | "codex"
  readonly model: string
}

const table: Record<Role, AgentChoice> = {
  researcher: { kind: "claude", model: "claude-haiku-5-5" },
  implementer: { kind: "claude", model: "claude-opus-5-5" },
  reviewer: { kind: "codex", model: "gpt-6.1-sol" },
}

/** The agent for a task: the role's, except a researcher on a `type=design` task gets the stronger model. */
export const agentFor = (role: Role, labels: Readonly<Record<string, string>>): AgentChoice =>
  role === "researcher" && labels.type === "design" ? { kind: "claude", model: "claude-fable-5-1" } : table[role]

export interface Executables {
  readonly claude: string
  readonly codex: string
}

/** The argv that runs one agent on one prompt; the prompt is a single item, never shell text. */
export const launchArgv = (agent: AgentChoice, prompt: string, exe: Executables): Array<string> =>
  agent.kind === "claude"
    ? [exe.claude, "--model", agent.model, "--permission-mode", "auto", "--output-format", "stream-json", "--verbose", "-p", prompt]
    : [exe.codex, "exec", "-m", agent.model, "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", prompt]
