import { create } from "zustand"

export type Project = {
  path: string
  name: string
  /** 项目外观（monocode 的每项目外观）：色板索引 / 自定义色 / 置顶 / Logo 图片。 */
  colorIndex?: number
  customColor?: string
  pinned?: boolean
  logoPath?: string
  /** 存在即已归档：不出现在项目列表，可从「已归档」里恢复。 */
  archivedAt?: number
}

/** Chrome 风格项目色板；[0] 是「未设置」的灰。 */
export const PROJECT_PALETTE = [
  "hsl(210 8% 58%)",
  "hsl(211 92% 62%)",
  "hsl(12 80% 58%)",
  "hsl(45 90% 55%)",
  "hsl(142 55% 50%)",
  "hsl(330 70% 62%)",
  "hsl(280 55% 62%)",
  "hsl(175 55% 48%)",
  "hsl(25 85% 58%)",
] as const

/** 未设置颜色时的稳定派生色：同一路径永远同一颜色。 */
export function derivedProjectColor(path: string): string {
  let hash = 0
  for (let index = 0; index < path.length; index++) {
    hash = (hash * 31 + path.charCodeAt(index)) >>> 0
  }
  return PROJECT_PALETTE[(hash % (PROJECT_PALETTE.length - 1)) + 1]
}

/** 项目颜色：显式设置优先，否则返回 null（调用方决定用默认还是派生色）。 */
export function projectColor(project: Project): string | null {
  if (project.customColor && /^#[0-9a-fA-F]{6}$/.test(project.customColor)) return project.customColor
  if (project.colorIndex != null && project.colorIndex >= 1 && project.colorIndex < PROJECT_PALETTE.length) {
    return PROJECT_PALETTE[project.colorIndex]
  }
  return null
}

/** 置顶优先的稳定排序。 */
export function sortPinnedFirst(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false))
}

/** 在列表里的项目 = 未归档。 */
export function activeProjects(projects: Project[]): Project[] {
  return projects.filter(project => project.archivedAt == null)
}

export function archivedProjects(projects: Project[]): Project[] {
  return projects.filter(project => project.archivedAt != null)
}

const PROJECTS_KEY = "pi-gui.projects.v1"
const LEGACY_PROJECTS_KEY = ["pi-gui", "projects"].join(".")

export function normalizeProjectPath(value: string): string {
  return value.replace(/\/+$/, "") || "/"
}

function normalizeProject(project: Project): Project {
  const path = normalizeProjectPath(project.path)
  return {
    path,
    name: project.name.trim() || path.split("/").filter(Boolean).at(-1) || "/",
    // 外观字段（颜色 / Logo / 置顶）原样保留，未设置就不写入。
    ...(project.colorIndex != null ? { colorIndex: project.colorIndex } : {}),
    ...(project.customColor ? { customColor: project.customColor } : {}),
    ...(project.pinned ? { pinned: true } : {}),
    ...(project.logoPath ? { logoPath: project.logoPath } : {}),
    ...(project.archivedAt != null ? { archivedAt: project.archivedAt } : {}),
  }
}

export function mergeProjects(existing: Project[], paths: string[]): Project[] {
  const all = new Map(existing.map(project => {
    const normalized = normalizeProject(project)
    return [normalized.path, normalized]
  }))
  for (const raw of paths) {
    const path = normalizeProjectPath(raw)
    if (!all.has(path)) all.set(path, normalizeProject({ path, name: path.split("/").filter(Boolean).at(-1) || "/" }))
  }
  return [...all.values()]
}

export function replaceProject(projects: Project[], nextProject: Project): Project[] {
  const next = normalizeProject(nextProject)
  return projects.some(project => project.path === next.path)
    ? projects.map(project => project.path === next.path ? next : project)
    : [...projects, next]
}

export function removeProject(projects: Project[], path: string): Project[] {
  return projects.filter(project => project.path !== path)
}

/** Reorder projects to match `paths`; unknown or duplicate paths are ignored. */
export function reorderProjects(projects: Project[], paths: string[]): Project[] {
  const byPath = new Map(projects.map(project => [project.path, project]))
  const next: Project[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    const project = byPath.get(path)
    if (!project || seen.has(path)) continue
    seen.add(path)
    next.push(project)
  }
  for (const project of projects) {
    if (!seen.has(project.path)) next.push(project)
  }
  return next
}

function persist(projects: Project[]): Project[] {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
  return projects
}

function load(): Project[] {
  try {
    const value = JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? localStorage.getItem(LEGACY_PROJECTS_KEY) ?? "[]")
    if (!Array.isArray(value)) return []
    return value
      .filter((item): item is Project => Boolean(item && typeof item.path === "string" && typeof item.name === "string"))
      .map(normalizeProject)
  } catch {
    return []
  }
}

export const useProjects = create<{
  projects: Project[]
  add: (paths: string[]) => void
  update: (project: Project) => void
  remove: (path: string) => void
  reorder: (paths: string[]) => void
}>(set => ({
  projects: load(),
  add: paths => set(state => ({ projects: persist(mergeProjects(state.projects, paths)) })),
  update: project => set(state => ({ projects: persist(replaceProject(state.projects, project)) })),
  remove: path => set(state => ({ projects: persist(removeProject(state.projects, path)) })),
  reorder: paths => set(state => ({ projects: persist(reorderProjects(state.projects, paths)) })),
}))
