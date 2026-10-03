/**
 * Desktop-only integration backed by official Tauri plugins: a global show/hide
 * hotkey, launch at login, and a completion notification. Every helper is a
 * no-op outside the desktop runtime, so the browser and mobile shells stay
 * unchanged.
 */
import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartIsEnabled } from "@tauri-apps/plugin-autostart"
import { isRegistered, register, unregister } from "@tauri-apps/plugin-global-shortcut"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"

/** Global hotkey that shows or hides the main window. */
export const GLOBAL_SHORTCUT = "CommandOrControl+Shift+O"
export const NOTIFY_ON_COMPLETE_KEY = "pi-gui.notifyOnComplete"

export async function readAutostart(): Promise<boolean> {
  return isTauri() ? autostartIsEnabled() : false
}

export async function writeAutostart(enabled: boolean): Promise<void> {
  if (!isTauri()) return
  await (enabled ? enableAutostart() : disableAutostart())
}

export async function readGlobalShortcut(): Promise<boolean> {
  return isTauri() ? isRegistered(GLOBAL_SHORTCUT) : false
}

export async function writeGlobalShortcut(enabled: boolean): Promise<void> {
  if (!isTauri()) return
  if (!enabled) {
    if (await isRegistered(GLOBAL_SHORTCUT)) await unregister(GLOBAL_SHORTCUT)
    return
  }
  await register(GLOBAL_SHORTCUT, event => {
    if (event.state !== "Pressed") return
    const window = getCurrentWindow()
    void window.isVisible().then(visible => visible ? window.hide() : window.show().then(() => window.setFocus()))
  })
}

/** Notify that a run finished. Silent while Orbit already has focus. */
export async function notifyRunComplete(body: string): Promise<void> {
  if (!isTauri()) return
  if (await getCurrentWindow().isFocused()) return
  if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return
  sendNotification({ title: "Orbit", body })
}
