import { persistState } from "./persistent"
import type { Panel } from "./store"

/**
 * Which surface Orbit lands on after a launch.
 *
 * The landing page is not session state: a cold start that always opens 「会话」
 * costs a click every time the user actually came back for the pairing QR. The
 * default is therefore 「移动端」 — the Host switch and the QR code, which is the
 * one panel a cold start exists for — and the choice is durable, so clearing the
 * WebView storage does not silently move it back.
 *
 * Only panels that make sense as a landing surface are offered: the transcript
 * panes and the settings pages are reached from the shell, not from a launch.
 */
export const STARTUP_PANEL_KEY = "orbit.startup.panel"

export const STARTUP_PANEL_DEFAULT: Panel = "mobile-access"

export const STARTUP_PANELS: { id: Panel; label: string }[] = [
  { id: "mobile-access", label: "移动端" },
  { id: "chat", label: "会话" },
  { id: "inbox", label: "收件箱" },
  { id: "notes", label: "笔记" },
  { id: "automations", label: "自动化" },
  { id: "search", label: "搜索" },
]

function known(panel: string | null): panel is Panel {
  return panel !== null && STARTUP_PANELS.some(entry => entry.id === panel)
}

/** The configured landing page; an unknown or missing value falls back. */
export function readStartupPanel(): Panel {
  try {
    const stored = localStorage.getItem(STARTUP_PANEL_KEY)
    return known(stored) ? stored : STARTUP_PANEL_DEFAULT
  } catch {
    return STARTUP_PANEL_DEFAULT
  }
}

export function writeStartupPanel(panel: Panel): void {
  const value = known(panel) ? panel : STARTUP_PANEL_DEFAULT
  try {
    localStorage.setItem(STARTUP_PANEL_KEY, value)
  } catch {
    // Storage unavailable: the default keeps the app usable, it just forgets.
  }
  persistState(STARTUP_PANEL_KEY, value)
}
