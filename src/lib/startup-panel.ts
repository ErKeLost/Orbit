import { persistState } from "./persistent"
import type { Panel } from "./store"

/**
 * Which surface Orbit lands on after a launch.
 *
 * The default is 「会话」: a cold start is nearly always "继续昨天那件事", and
 * landing on a settings page costs a click — and a moment of "我怎么在这儿" —
 * every single time. Pairing a phone is something you do once and go looking for
 * (设置 → 通用 → 启动页面 也可以把它设成启动页)，所以它不该是默认。
 *
 * The choice is durable, so clearing the WebView storage does not silently move
 * it back. Only panels that make sense as a landing surface are offered: the
 * transcript panes and the settings pages are reached from the shell, not from a
 * launch.
 */
export const STARTUP_PANEL_KEY = "orbit.startup.panel"

export const STARTUP_PANEL_DEFAULT: Panel = "chat"

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
