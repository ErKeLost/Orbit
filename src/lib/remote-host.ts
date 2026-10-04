import { invoke } from "@tauri-apps/api/core"
import { REMOTE_PROTOCOL, type RemoteTheme } from "./remote-protocol"

export type RelaySettingsStatus = {
  relayUrl: string
  hasHostKey: boolean
}

export type RemoteHostInfo = {
  running: true
  mode: "lan" | "relay" | "auto"
  protocol: typeof REMOTE_PROTOCOL
  hostId: string
  advertisedAddress: string
  port: number
  token: string
  pairingUri: string
  machineName: string
  connectedClients: number
  relayUrl?: string | null
  relayConnected: boolean
}

export function relaySettingsStatus(): Promise<RelaySettingsStatus> {
  return invoke<RelaySettingsStatus>("relay_settings_status")
}

export function saveRelaySettings(settings: { relayUrl: string; hostKey: string }): Promise<RelaySettingsStatus> {
  return invoke<RelaySettingsStatus>("save_relay_settings", { settings })
}

export function startRemoteHost(options: { mode?: "lan" | "relay" | "auto"; port?: number } = {}): Promise<RemoteHostInfo> {
  return invoke<RemoteHostInfo>("remote_host_start", {
    bindAddress: null,
    mode: options.mode ?? null,
    port: options.port ?? null,
  })
}

/**
 * Whether mobile access should be running.
 *
 * The Host lives in the desktop process, so quitting Orbit — which is exactly
 * what granting screen recording requires, since TCC re-checks at launch —
 * silently takes the phone's connection with it. Remembering the intent is what
 * lets the phone reconnect on its own instead of retrying forever against a
 * process that is no longer listening.
 */
const ENABLED_KEY = "orbit.remote.hostEnabled"

export function rememberRemoteHostEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(ENABLED_KEY, "true")
    else localStorage.removeItem(ENABLED_KEY)
  } catch {
    // Private mode or a locked profile; the Host still works, it just will not
    // come back by itself.
  }
}

/**
 * Restart the Host if it was running when Orbit last exited.
 *
 * Used automatically — never silently: the intent is only ever set by the user
 * turning mobile access on.
 */
export async function restoreRemoteHost(): Promise<RemoteHostInfo | null> {
  let enabled = false
  try {
    enabled = localStorage.getItem(ENABLED_KEY) === "true"
  } catch {
    return null
  }
  if (!enabled) return null
  const mode = (localStorage.getItem("orbit.remote.transport") as "lan" | "relay" | "auto" | null) ?? "lan"
  // A relay is only usable once its settings exist; falling back to LAN keeps
  // the phone reachable on the local network instead of failing outright.
  return startRemoteHost({ mode: mode === "relay" ? "relay" : mode }).catch(() =>
    mode === "lan" ? Promise.reject(new Error("无法恢复移动访问")) : startRemoteHost({ mode: "lan" }),
  )
}

export function getRemoteHost(): Promise<RemoteHostInfo | null> {
  return invoke<RemoteHostInfo | null>("remote_host_status")
}

export function stopRemoteHost(): Promise<void> {
  return invoke<void>("remote_host_stop")
}

/** Desktop-only source of truth for the theme mirrored to mobile clients. */
export function setRemoteHostTheme(theme: RemoteTheme): Promise<void> {
  return invoke<void>("remote_host_set_theme", { theme })
}
