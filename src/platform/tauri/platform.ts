/**
 * Platform facts for Tauri surfaces. `IS_MAC` / `IS_WIN` / `MOD` come from
 * `lib/platform` (one definition); the rest describe the glass/blur support
 * this build ships with.
 */
import { IS_MAC, IS_WIN } from "../../lib/platform";

export { IS_MAC, IS_WIN, MOD } from "../../lib/platform";

export const IS_LINUX =
  typeof navigator !== "undefined" && /Linux/i.test(navigator.platform);

/** Native desktop blur on macOS/Windows; transparency-only glass on Linux. */
export const HAS_NATIVE_GLASS = IS_MAC || IS_WIN || IS_LINUX;

export const ALT = IS_MAC ? "⌥" : "Alt+";
export const SHIFT = IS_MAC ? "⇧" : "Shift+";
