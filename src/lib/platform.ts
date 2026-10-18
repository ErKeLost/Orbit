/**
 * The one place that answers "which platform is this webview on".
 *
 * `navigator.platform` is what every surface here already read (Tauri's webview
 * keeps it accurate on macOS/Windows/Linux), so this stays a single read
 * instead of a copy per module.
 */
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const IS_WIN =
  typeof navigator !== "undefined" && /Win/i.test(navigator.platform);

/** The platform's primary modifier, as it is spelled inside a label. */
export const MOD = IS_MAC ? "⌘" : "Ctrl+";
