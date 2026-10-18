/**
 * The phone can run the desktop's own commands (`host.invoke`), so the set of
 * reachable commands is a security boundary and the *only* place where "the
 * phone may do X" is decided.
 *
 * Two ways it can go wrong, both invisible at runtime:
 *
 * * an allowlisted name that no longer exists — the phone asks for a command
 *   that was renamed and gets "命令没有远端实现" only when a user tries it;
 * * a new command that nobody decided about — it silently stays desktop-only,
 *   which is how "my phone cannot open files" happens in the first place.
 *
 * So every registered command must be either mirrored or explicitly excluded
 * with a reason, and the exclusion list may not rot.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const REMOTE_OPS = readFileSync("src-tauri/src/remote_ops.rs", "utf8")
const LIB = readFileSync("src-tauri/src/lib.rs", "utf8")

function filesUnder(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) found.push(...filesUnder(path))
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) found.push(path)
  }
  return found
}

/** Names passed to `tauri::generate_handler!`. */
function registeredCommands(): string[] {
  const block = LIB.slice(LIB.indexOf("generate_handler!["))
  const body = block.slice(0, block.indexOf("])"))
  return [...body.matchAll(/^\s*(?:#\[[^\]]+\]\s*)?[a-z_]+::([a-z0-9_]+),?/gm)]
    .map((match) => match[1]!)
    .sort()
}

/** Names in the `REMOTE_COMMANDS` table. */
function allowedCommands(): string[] {
  const start = REMOTE_OPS.indexOf("pub const REMOTE_COMMANDS")
  const body = REMOTE_OPS.slice(start, REMOTE_OPS.indexOf("];", start))
  return [...body.matchAll(/^\s*"([a-z0-9_]+)",/gm)].map((match) => match[1]!).sort()
}

/** Names the `dispatch` match answers, read from its arms. */
function dispatchedCommands(): string[] {
  const start = REMOTE_OPS.indexOf("pub async fn dispatch")
  const end = REMOTE_OPS.indexOf("/// Look a payload key up", start)
  const body = REMOTE_OPS.slice(start, end)
  // An arm may carry a `#[cfg(...)]` attribute on the line above it.
  return [...body.matchAll(/^\s*(?:#\[[^\]]+\]\s*)?"([a-z0-9_]+)" =>/gm)].map((match) => match[1]!).sort()
}

/**
 * Commands that are deliberately desktop-only, with the reason. Each one is
 * about *the device the phone is holding*, or about the pairing host itself.
 */
const EXCLUDED: Record<string, string> = {
  runtime_environment: "the phone's own runtime boundary; it decides the routing",
  splash_ready: "the splash window exists on the desktop only",
  mobile_update_probe: "checks this phone's APK",
  mobile_update_install: "installs on this phone",
  background_connection_status: "the phone's own service state",
  set_background_connection: "starts and stops a service on the phone",
  remote_host_start: "the Host's lifecycle; a phone that stopped it would cut itself off",
  remote_host_stop: "the Host's lifecycle",
  remote_host_status: "the Host's lifecycle",
  remote_host_set_theme: "the Host's own chrome",
  publish_projects: "the desktop window publishing its registry; not a phone question",
  relay_settings_status: "pairing transport configuration",
  save_relay_settings: "pairing transport configuration",
  // 切换会话的两条快路径都建立在「这台机器的磁盘」上：`session_stamp` 读文件戳，
  // `session_tail` 直接读会话 JSONL 的尾部。手机不跑这套缓存（它通过 remote host
  // 的 session.list/get_messages 拿历史），而且尾页里抽出来的图片路径是本机的。
  session_stamp: "checks this machine's session file for the desktop's transcript cache",
  session_project: "projects this machine's session JSONL; the phone uses the Host's session.list/get_messages",
  session_image: "reads one image out of this machine's session JSONL",
  set_keep_awake: "the wake assertion belongs to the machine it protects",
  pi_connect: "hands out a webview-local event channel; phones attach instead",
  clipboard_file_paths: "reads the clipboard of the device in front of the user",
  read_file_attachment: "takes a path from a picker on this device",
  save_media_file: "writes to a path chosen on this device",
  copy_media_file: "copies to a path chosen on this device",
  screen_status: "the screen channel is captured and subscribed, not called",
  screen_displays: "the screen channel is captured and subscribed, not called",
  screen_request_permission: "screen-recording consent is given at the desktop",
  screen_stop: "the screen channel is captured and subscribed, not called",
  git_checkpoint_capture: "captures this machine's working tree",
  git_checkpoint_diff: "reads this machine's git objects",
  git_checkpoint_restore: "writes this machine's working tree",
  // 语音转写在桌面今天就是仅本机的：读写这台机器的 speech.json / auth.json，
  // 转写请求也从桌面的网络发出。镜像到手机等手机端麦克风权限打通后再说。
  // 浏览器栏在桌面上（screencast 帧 + 真实 Chrome 进程），手机端没有这一栏：
  // 它的「屏幕」通道给的是桌面像素，不是浏览器的 DOM，因此这三个命令先只在桌面。
  // 第三栏的引擎视图是窗口里的一个子视图，不是可以远端调用的东西：它没有
  // 客户端连接的概念，而且 `browser_view_eval` 能在这个页面上执行任意脚本。
  browser_view_sync: "places the desktop window's own child web view",
  browser_view_navigate: "drives the desktop window's own child web view",
  browser_view_go: "drives the desktop window's own child web view",
  browser_view_reload: "drives the desktop window's own child web view",
  browser_view_stop: "drives the desktop window's own child web view",
  browser_view_eval: "runs a script inside the desktop window's child web view",
  browser_view_status: "reports the desktop window's own child web view",
  browser_view_activate: "says which desktop browser tab is in front",
  browser_view_page: "reads the title, address and load flag of the desktop's browser tab",
  browser_view_close: "closes the desktop window's own child web view",
  browser_view_reconcile: "closes this window's child web views whose tab is gone",
  // The import is about *this* machine's profiles: it reads another browser's
  // cookie database and writes the desktop's own browser profile. A phone has
  // neither side of that, and nothing about it is a phone question.
  browser_import_sources: "lists this machine's browser profiles",
  browser_import_state: "reports this machine's last browser-login import",
  browser_import_session: "copies a session between this machine's browser profiles",
  browser_open: "starts the desktop's own Chrome and its screencast",
  browser_status: "reports the desktop's Chrome session",
  browser_close: "stops the desktop's Chrome process",
  browser_client_report: "writes the desktop's own log; there is no browser column on the phone",
  // Pre-existing gap, recorded here rather than left undecided: this writes the
  // desktop's mcp.json, which the phone cannot read back or act on.
  set_mcp_auto_codemode: "writes the desktop's mcp.json configuration",
  speech_config: "reads the desktop's speech.json; the phone has no agent dir",
  save_speech_config: "writes the desktop's speech.json",
  save_speech_api_key: "writes the desktop's auth.json",
  transcribe_audio: "desktop voice input; the phone has no mic permission plumbing yet",
}

describe("remote command boundary", () => {
  test("every registered command is mirrored or explicitly excluded", () => {
    const allowed = new Set(allowedCommands())
    const undecided = registeredCommands().filter((name) => !allowed.has(name) && !(name in EXCLUDED))
    expect({ undecided }).toEqual({ undecided: [] })
  })

  test("the exclusion list does not outlive the commands it describes", () => {
    const registered = new Set(registeredCommands())
    const allowed = new Set(allowedCommands())
    const stale = Object.keys(EXCLUDED).filter((name) => !registered.has(name))
    const mirrored: string[] = []
    for (const name of Object.keys(EXCLUDED)) {
      // A name that is both excluded and allowed would be a contradiction: the
      // allowlist would win at runtime and the reason would be a lie.
      if (allowed.has(name)) mirrored.push(name)
    }
    expect({ stale, mirrored }).toEqual({ stale: [], mirrored: [] })
  })

  test("the allowlist and the dispatch table agree", () => {
    const allowed = new Set(allowedCommands())
    const dispatched = new Set(dispatchedCommands())
    const unhandled = [...allowed].filter((name) => !dispatched.has(name))
    const unreachable = [...dispatched].filter((name) => !allowed.has(name))
    // `ax_observe` is compiled only on macOS, so it is allowed but may be
    // missing from the arms elsewhere; everything else must line up.
    expect({ unhandled, unreachable }).toEqual({ unhandled: [], unreachable: [] })
  })

  test("every allowlisted name is a registered command", () => {
    const registered = new Set(registeredCommands())
    const unknown = allowedCommands().filter((name) => !registered.has(name))
    expect({ unknown }).toEqual({ unknown: [] })
  })

  test("every call goes through the router", () => {
    // The mirror only works while `invoke` is the app's own (`lib/native.ts`),
    // which decides between the local backend and the paired desktop. One direct
    // import of Tauri's `invoke` elsewhere is how a new feature quietly becomes
    // desktop-only — the exact defect this whole boundary exists to prevent.
    const direct: string[] = []
    for (const file of filesUnder("src")) {
      if (file.endsWith("lib/native.ts")) continue
      const source = readFileSync(file, "utf8")
      if (/import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*"@tauri-apps\/api\/core"/.test(source)) direct.push(file)
    }
    expect({ direct }).toEqual({ direct: [] })
  })
})
