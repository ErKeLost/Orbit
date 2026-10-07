import { create } from "zustand"

export type Project = {
  path: string
  name: string
  roots?: string[]
}

const PROJECTS_KEY = "pi-gui.projects.v1"
const LEGACY_PROJECTS_KEY = ["pi-gui", "projects"].join(".")

export function normalizeProjectPath(value: string): string {
  return value.replace(/\/+$/, "") || "/"
}

export function projectRoots(project: Project): string[] {
  const seen = new Set<string>()
  return [project.path, ...(project.roots ?? [])].flatMap(value => {
    const path = normalizeProjectPath(value)
    if (seen.has(path)) return []
    seen.add(path)
    return [path]
  })
}

export function projectExtraRoots(project: Project): string[] {
  return projectRoots(project).slice(1)
}

function normalizeProject(project: Project): Project {
  const path = normalizeProjectPath(project.path)
  const roots = projectRoots({ ...project, path })
  return {
    path,
    name: project.name.trim() || path.split("/").filter(Boolean).at(-1) || "/",
    ...(roots.length > 1 ? { roots } : {}),
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
