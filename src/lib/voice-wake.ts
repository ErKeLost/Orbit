import { useWorkspace } from "./store"

const listeners = new Set<() => void>()

/** Two volume-down presses, from the Android shell. The page decides what a wake means. */
export function installVoiceWake(): void {
  if (typeof window === "undefined") return
  const host = window as Window & { __orbitVoiceWake?: () => void }
  host.__orbitVoiceWake = () => {
    for (const listener of listeners) listener()
  }
}

export function onVoiceWake(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Open the voice page. Starting the call is the page's job, so a wake never talks over one. */
export function openVoiceFromWake(): void {
  const workspace = useWorkspace.getState()
  if (workspace.runtimeTarget !== "mobile") return
  if (workspace.panel !== "voice") workspace.set({ panel: "voice" })
}
