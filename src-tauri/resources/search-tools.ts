import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * `grep` 走 ripgrep、尊重 .gitignore。
 *
 * pi 默认只激活 `read`/`bash`/`edit`/`write`，`grep` 虽已注册却不在激活集里，
 * 于是系统提示里只剩「用 bash 做搜索」，模型便退回 bash 的 `grep -r`：不读 .gitignore、
 * 在大仓库上非常慢。会话开始时按需补上，等价于在「设置 → 工具」里手工打开它。
 *
 * 只要 `grep`：`find`/`ls` 仍留给使用者自己决定。
 */
export const FAST_SEARCH_TOOLS = ["grep"] as const
/** 即使内置 grep 被手动关掉，也不该退回递归 grep。 */
export const FAST_SEARCH_GUIDELINE =
  "查找文件内容用 `grep` 工具（或 bash 里的 `rg`），不要用 `grep -r`：递归 grep 不读 .gitignore，在大仓库上很慢。"

type SearchToolApi = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">

/** 补上缺失的搜索工具（目前只有 grep），返回本次新增的名字。 */
export function enableFastSearchTools(pi: SearchToolApi): string[] {
  const available = new Set(pi.getAllTools().map((tool) => tool.name))
  const active = pi.getActiveTools()
  const missing = FAST_SEARCH_TOOLS.filter((name) => available.has(name) && !active.includes(name))
  if (missing.length > 0) pi.setActiveTools([...active, ...missing])
  return missing
}
