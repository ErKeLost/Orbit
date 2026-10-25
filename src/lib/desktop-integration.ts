/**
 * Desktop-only integration backed by official Tauri plugins: a global show/hide
 * hotkey, launch at login, and a completion notification. Every helper is a
 * no-op outside the desktop runtime, so the browser and mobile shells stay
 * unchanged.
 */
import { isTauri } from "@tauri-apps/api/core";
import { invoke } from "./native";
import { getCurrentWindow } from "@tauri-apps/api/window"
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartIsEnabled } from "@tauri-apps/plugin-autostart"
import { isRegistered, register, unregister } from "@tauri-apps/plugin-global-shortcut"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import { persistState } from "./persistent"

/** Global hotkey that shows or hides the main window. */
export const GLOBAL_SHORTCUT = "CommandOrControl+Shift+O"

/**
 * Global hotkey for the quick composer (monocod 的 ⌘⇧Space)。
 *
 * 和上面那个是两个独立的注册：一个是「把 Orbit 拿到面前」，一个是「说一句话」，
 * 后者不该先把整个应用亮出来。
 */
export const QUICK_COMPOSER_SHORTCUT = "CommandOrControl+Shift+Space"
export const NOTIFY_ON_COMPLETE_KEY = "pi-gui.notifyOnComplete"

/**
 * Whether Orbit holds the machine awake while it runs.
 *
 * The mobile Host lives in this process, so a computer that idles itself to
 * sleep takes the phone's connection with it — and the phone has no way to tell
 * the difference between "the Mac is asleep" and "the Mac is gone". The
 * assertion is what `caffeinate` creates, held by the app rather than by a
 * window, so it covers the whole run instead of one surface.
 *
 * Default on: the reason to open Orbit and leave it open is the reason to keep
 * the machine reachable. It stays a setting because a laptop on battery may
 * reasonably disagree.
 */
export const KEEP_AWAKE_KEY = "orbit.keepAwake"

export function readKeepAwake(): boolean {
  try {
    return localStorage.getItem(KEEP_AWAKE_KEY) !== "false"
  } catch {
    return true
  }
}

/**
 * Apply the assertion and remember the choice.
 *
 * Returns whether the machine is actually held awake: the native answer on the
 * desktop, where IOKit can refuse, and the request itself in the browser
 * preview, which has no settings row to report a refusal to.
 */
export async function writeKeepAwake(enabled: boolean): Promise<boolean> {
  const value = String(enabled)
  try {
    localStorage.setItem(KEEP_AWAKE_KEY, value)
  } catch {
    // Storage unavailable; the preference applies to this run only.
  }
  persistState(KEEP_AWAKE_KEY, value)
  if (!isTauri()) return enabled
  return invoke<boolean>("set_keep_awake", { enabled })
}

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

/** 注册唤起 quick composer 的全局快捷键；返回注销函数。 */
export async function installQuickComposerShortcut(): Promise<() => void> {
  if (!isTauri()) return () => {}
  try {
    if (await isRegistered(QUICK_COMPOSER_SHORTCUT)) await unregister(QUICK_COMPOSER_SHORTCUT)
    await register(QUICK_COMPOSER_SHORTCUT, event => {
      if (event.state !== "Pressed") return
      void invoke("quick_toggle")
    })
  } catch {
    // 被别的应用占了就安静放弃：这个功能是便利，不是必需。
    return () => {}
  }
  return () => void unregister(QUICK_COMPOSER_SHORTCUT).catch(() => {})
}

/** Notify that a run finished. Silent while Orbit already has focus. */
export async function notifyRunComplete(body: string): Promise<void> {
  if (!isTauri()) return
  if (await getCurrentWindow().isFocused()) return
  if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return
  sendNotification({ title: "Orbit", body })
}
