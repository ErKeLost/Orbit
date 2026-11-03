import { normalizeProjectPath, projectExtraRoots, type Project } from "./projects"

export const WORKSPACE_STATUS = "gui-workspace"

export function extraRootsFromStatus(statuses: Record<string, string>): string[] {
  const text = statuses[WORKSPACE_STATUS]
  return text ? (JSON.parse(text) as { roots: string[] }).roots : []
}

/** 状态文本可能损坏（旧版本/手改），解析失败按没有附加 root 处理。 */
export function sessionRootsFromStatuses(statuses: Record<string, string>): string[] {
  try {
    return extraRootsFromStatus(statuses)
  } catch {
    return []
  }
}

/**
 * Composer 顶部要展示的附加 root 列表。
 *
 * 两个来源取并集：会话状态（`gui-workspace`，当前会话实际生效的）优先，
 * 项目配置（编辑过还没同步到会话的）兜底——这样编辑完立刻可见，同步失败
 * 也不至于消失。主 checkout 本身不算附加 root。
 */
export function workspaceExtraRootList(
  projectFolder: string,
  statuses: Record<string, string>,
  projects: Project[],
): string[] {
  const home = normalizeProjectPath(projectFolder)
  const seen = new Set([home])
  const configured = projects.find((project) => normalizeProjectPath(project.path) === home)
  const candidates = [...sessionRootsFromStatuses(statuses), ...(configured ? projectExtraRoots(configured) : [])]
  const out: string[] = []
  for (const value of candidates) {
    const path = normalizeProjectPath(value)
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

export function shortenPath(path: string, homeDir: string): string {
  if (path === homeDir) return "~"
  return homeDir && path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path
}
