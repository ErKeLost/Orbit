import { useEffect } from "react"
import { listen } from "@tauri-apps/api/event"
import { invoke } from "../lib/native"
import { useProjects, type Project } from "../lib/projects"
import { connect, report } from "../lib/rpc"
import { useRemoteProjects } from "../lib/remote-workspace"
import { useWorkspace } from "../lib/store"

/** Emitted by the Host when a phone asks to change the project registry. */
const PROJECT_REQUEST_EVENT = "orbit://projects/request"

type ProjectRequest = { action: "add" | "forget"; path: string }

function published(projects: Project[]) {
  return projects.map((project) => ({
    path: project.path,
    name: project.name,
    ...(project.roots?.length ? { roots: project.roots } : {}),
  }))
}

/**
 * Keep the two sides looking at one project registry.
 *
 * The desktop's window owns the list — it holds the names, the extra roots and
 * the order — so on the desktop this publishes it to the Host (which serves it
 * in every snapshot and pushes it to connected phones), and on the phone it
 * mirrors what the Host published into the local store, so every surface that
 * resolves a project name sees the desktop's list rather than a private one.
 *
 * A phone that asks to add or forget a project sends the request to the Host,
 * which hands it to this same code on the desktop — one writer, and the result
 * travels back through the publication rather than through the reply.
 */
export function useProjectRegistry() {
  const target = useWorkspace((state) => state.runtimeTarget)
  const remote = useRemoteProjects()
  const desktop = target === "desktop"
  const mobile = target === "mobile"

  useEffect(() => {
    if (!desktop) return
    const publish = (projects: Project[]) => {
      void invoke("publish_projects", { projects: published(projects) }).catch(() => undefined)
    }
    publish(useProjects.getState().projects)
    return useProjects.subscribe((state, previous) => {
      if (state.projects !== previous.projects) publish(state.projects)
    })
  }, [desktop])

  useEffect(() => {
    if (!desktop) return
    const unlisten = listen<ProjectRequest>(PROJECT_REQUEST_EVENT, (event) => {
      void applyProjectRequest(event.payload).catch(report)
    })
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [desktop])

  useEffect(() => {
    if (!mobile) return
    const projects = remote.map((project) => ({
      path: project.path,
      name: project.name,
      ...(project.roots?.length ? { roots: project.roots } : {}),
    }))
    // Mirroring is a plain swap, not a merge: the desktop is the source of
    // truth, and a project removed there must disappear here too.
    const current = useProjects.getState().projects
    const same = current.length === projects.length && current.every((project, index) =>
      project.path === projects[index]?.path && project.name === projects[index]?.name)
    if (!same) useProjects.setState({ projects })
  }, [mobile, remote])
}

/**
 * Apply a request from a paired phone.
 *
 * Adding opens the project as well as listing it: a phone can only attach to a
 * project that has a live Pi connection on the desktop, and "I just added this
 * project on my phone" means the user wants to work in it now. Forgetting falls
 * back the way the desktop's own remove does, so the workspace is never left
 * pointing at a project that is no longer listed.
 */
async function applyProjectRequest({ action, path }: ProjectRequest): Promise<void> {
  const state = useProjects.getState()
  if (action === "add") {
    state.add([path])
    if (useWorkspace.getState().cwd !== path) await connect(path, "project")
    return
  }
  const wasActive = useWorkspace.getState().cwd === path
  state.remove(path)
  if (!wasActive) return
  const fallback = useProjects.getState().projects[0]
  const home = useWorkspace.getState().homeDir
  if (fallback) await connect(fallback.path, "project")
  else if (home) await connect(home, "home")
}
