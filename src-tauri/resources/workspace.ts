import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

export const WORKSPACE_TYPE = "pi-gui-workspace"
export const WORKSPACE_STATUS = "gui-workspace"
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"]

type WorkspaceEntry = { type: string; customType?: string; data?: { roots?: string[] } }

export function extraRoots(cwd: string, roots: string[]): string[] {
  const home = cwd.replace(/\/+$/, "") || "/"
  const seen = new Set([home])
  return roots.flatMap((root) => {
    const path = root.replace(/\/+$/, "") || "/"
    if (seen.has(path)) return []
    seen.add(path)
    return [path]
  })
}

export function storedRoots(entries: WorkspaceEntry[], cwd: string): string[] {
  const entry = entries.findLast((item) => item.type === "custom" && item.customType === WORKSPACE_TYPE)
  return extraRoots(cwd, entry?.data?.roots ?? [])
}

export function readRootContext(root: string): string | undefined {
  const path = CONTEXT_FILES.map((name) => join(root, name)).find(existsSync)
  return path ? readFileSync(path, "utf8") : undefined
}

export function workspacePrompt(cwd: string, extras: string[], contexts: { root: string; text: string }[]): string | undefined {
  if (!extras.length) return
  const listing = [cwd, ...extras].map((root) => `- ${root}`).join("\n")
  const files = contexts.map(({ root, text }) => `<root path="${root}">\n${text}\n</root>`).join("\n\n")
  return `<attached_roots>
Session home (process cwd): ${cwd}
Attached roots:
${listing}
Use absolute paths. Relative paths resolve to the session home.
${files ? `\n${files}` : ""}
</attached_roots>`
}

function publish(ctx: Pick<ExtensionContext, "cwd" | "sessionManager" | "ui">) {
  const roots = storedRoots(ctx.sessionManager.getEntries(), ctx.cwd)
  ctx.ui.setStatus(WORKSPACE_STATUS, JSON.stringify({ roots }))
}

export function registerWorkspace(pi: ExtensionAPI): void {
  pi.registerCommand("gui-workspace-set", {
    description: "GUI: attach extra project roots to this session",
    handler: async (args, ctx) => {
      const input = JSON.parse(args) as { roots?: unknown }
      if (!Array.isArray(input.roots) || input.roots.some(root => typeof root !== "string")) throw new Error("Expected roots array")
      const roots = extraRoots(ctx.cwd, input.roots)
      const current = storedRoots(ctx.sessionManager.getEntries(), ctx.cwd)
      if (roots.length !== current.length || roots.some((root, index) => root !== current[index])) pi.appendEntry(WORKSPACE_TYPE, { roots })
      ctx.ui.setStatus(WORKSPACE_STATUS, JSON.stringify({ roots }))
    },
  })
  pi.on("session_start", (_event, ctx) => publish(ctx))
  pi.on("resources_discover", (_event, ctx) => {
    const extras = storedRoots(ctx.sessionManager.getEntries(), ctx.cwd)
    if (!extras.length) return
    return { skillPaths: extras.flatMap((root) => [join(root, ".pi/skills"), join(root, ".agents/skills")]) }
  })
  pi.on("before_agent_start", (event, ctx) => {
    const extras = storedRoots(ctx.sessionManager.getEntries(), ctx.cwd)
    const prompt = workspacePrompt(
      ctx.cwd,
      extras,
      extras.flatMap((root) => {
        const text = readRootContext(root)
        return text ? [{ root, text }] : []
      }),
    )
    if (!prompt) return
    return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` }
  })
}
