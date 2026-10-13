/**
 * Canonical agent paths, ported from Codex's `codex-rs/protocol/src/agent_path.rs`.
 *
 * Every agent in the tree has a stable path: the supervisor is `/root`, and a
 * worker spawned with `task_name` is `<spawner path>/<task_name>`. The path is
 * the durable identity a model refers to, so it can address a worker by its
 * full path, by a path relative to itself, or by the opaque agent id.
 *
 * Names are deliberately restrictive (lowercase letters, digits, underscores).
 * A path segment must survive being written into a prompt and typed back by a
 * model without quoting rules, so anything ambiguous is rejected up front.
 */

export const ROOT_PATH = "/root"
const ROOT_SEGMENT = "root"

const NAME_PATTERN = /^[a-z0-9_]+$/

/** Error message when `name` may not be used as a path segment, else undefined. */
export function validateAgentName(name: string): string | undefined {
  if (!name) return "task_name must not be empty"
  if (name === ROOT_SEGMENT) return "task_name `root` is reserved"
  if (name === "." || name === "..") return `task_name \`${name}\` is reserved`
  if (name.includes("/")) return "task_name must not contain `/`"
  if (!NAME_PATTERN.test(name)) return "task_name must use only lowercase letters, digits, and underscores"
  return undefined
}

/** Absolute path check mirroring Codex's `validate_absolute_path`. */
export function validateAgentPath(path: string): string | undefined {
  if (!path.startsWith("/")) return "absolute agent paths must start with `/root`"
  const stripped = path.slice(1)
  const [head, ...rest] = stripped.split("/")
  if (head !== ROOT_SEGMENT) return "absolute agent paths must start with `/root`"
  if (stripped.endsWith("/")) return "absolute agent path must not end with `/`"
  // Only the segments *below* `/root` are agent names; `/root` alone is valid.
  for (const segment of rest) {
    const error = validateAgentName(segment)
    if (error) return error
  }
  return undefined
}

/** The last segment of a path; `/root` reports `root`. */
export function agentPathName(path: string): string {
  if (path === ROOT_PATH) return ROOT_SEGMENT
  const segment = path.split("/").filter(Boolean).pop()
  return segment || ROOT_SEGMENT
}

/**
 * Child path for `name`, or undefined when the name is not usable.
 * `joinAgentPath("/root", "worker") === "/root/worker"`.
 */
export function joinAgentPath(parent: string, name: string): string | undefined {
  if (validateAgentName(name)) return undefined
  return `${parent.replace(/\/+$/, "")}/${name}`
}

/**
 * Resolve a model-supplied reference against the current agent's path.
 *
 * Mirrors Codex's `AgentPath::resolve`: `/root` is the root, a leading `/` means
 * absolute, anything else is relative to `current`.
 */
export function resolveAgentPath(current: string, reference: string): string | undefined {
  if (!reference) return undefined
  if (reference === ROOT_PATH) return ROOT_PATH
  if (reference.startsWith("/")) return validateAgentPath(reference) ? undefined : reference
  if (reference.endsWith("/")) return undefined
  const segments = reference.split("/")
  for (const segment of segments) if (validateAgentName(segment)) return undefined
  return `${current.replace(/\/+$/, "")}/${reference}`
}
