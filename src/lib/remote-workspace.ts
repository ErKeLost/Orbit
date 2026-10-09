import { create } from "zustand"
import type { RemoteProject } from "./remote-protocol"

/**
 * What the paired desktop offers, as it last told us.
 *
 * Two facts, both owned by the desktop and merely mirrored here:
 *
 * * `commands` — the commands this Host will answer over `host.invoke`. The
 *   phone routes a call to the Host only when it is on this list, which means
 *   the phone needs no copy of the allowlist to keep in step: an older APK
 *   against a newer desktop keeps working with whatever it already knew, and a
 *   command the desktop refuses is never sent at all.
 * * `projects` — the desktop's own project registry. Its window is the writer
 *   (names, extra roots, order), so the phone renders this list instead of
 *   keeping a second one that would drift.
 *
 * Both arrive with every snapshot and are refreshed by the one-way `host.theme`
 * / `host.projects` events, so a change made on either side lands on the other
 * without a reconnect.
 */
type RemoteWorkspaceState = {
  /** `null` until the first snapshot: "unknown" is not "nothing allowed". */
  commands: string[] | null
  projects: RemoteProject[]
  setCommands: (commands: readonly string[] | null) => void
  setProjects: (projects: readonly RemoteProject[]) => void
}

export const useRemoteWorkspace = create<RemoteWorkspaceState>((set) => ({
  commands: null,
  projects: [],
  setCommands: (commands) => set((state) => {
    const next = commands ? [...commands] : null
    if (state.commands === next) return state
    if (state.commands && next && state.commands.length === next.length && state.commands.every((name, index) => name === next[index])) return state
    return { commands: next }
  }),
  setProjects: (projects) => set({ projects: [...projects] }),
}))

/** Whether the paired desktop has said it answers this command. */
export function remoteCanInvoke(command: string): boolean {
  return useRemoteWorkspace.getState().commands?.includes(command) ?? false
}

/** The desktop's project registry, or an empty list before the first snapshot. */
export function remoteProjects(): RemoteProject[] {
  return useRemoteWorkspace.getState().projects
}

export function useRemoteProjects(): RemoteProject[] {
  return useRemoteWorkspace((state) => state.projects)
}
