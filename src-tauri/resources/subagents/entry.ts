import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerSubagentTools } from "./index.ts"
import { enableFastSearchTools } from "../search-tools.ts"

/** Minimal child extension. It intentionally contains no GUI/session helpers. */
export default function (pi: ExtensionAPI): void {
  registerSubagentTools(pi)
  // 子 agent 也要能用 ripgrep 版 grep，而不是退回 bash 的 `grep -r`。
  pi.on("session_start", () => { enableFastSearchTools(pi) })
}
