/**
 * The channels a worker looks in: every top-level channel but hq, as a `<name>/` prefix so a
 * claim also covers its sub-channels. `AGENT_CHANNELS` (a comma list) replaces the list.
 */
export const projectChannels = (paths: ReadonlyArray<string>, override?: string): Array<string> => {
  if (override !== undefined && override.trim() !== "")
    return override.split(",").map((c) => c.trim()).filter((c) => c !== "")
  const tops = new Set<string>()
  for (const path of paths) {
    const top = path.split("/")[0]
    if (top !== undefined && top !== "" && top !== "hq") tops.add(top)
  }
  return [...tops].sort().map((top) => `${top}/`)
}
