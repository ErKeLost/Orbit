import { existsSync, cpSync, rmSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const clipboardScope = resolve(root, "node_modules/@mariozechner")
const clipboardPackages = existsSync(clipboardScope)
  ? readdirSync(clipboardScope).filter(name => name === "clipboard" || name.startsWith("clipboard-"))
    .map(name => `@mariozechner/${name}`)
  : []
// Pi 0.87 no longer hoists its optional clipboard dependency into every
// installation. Orbit checks and loads this package from its own resources,
// so make the runtime dependency explicit and fail the build if it is absent.
const runtimePackages = [
  "@typesafe-ai",
  "@mariozechner/clipboard",
  ...clipboardPackages.filter(name => name !== "@mariozechner/clipboard"),
]

mkdirSync(resolve(root, "src-tauri/resources"), { recursive: true })

for (const name of runtimePackages) {
  const packageSource = resolve(root, "node_modules", name)
  const packageTarget = resolve(root, "src-tauri/resources/node_modules", name)
  if (!existsSync(packageSource)) {
    console.error(`缺少 ${name} 运行依赖，请先安装项目依赖`)
    process.exit(1)
  }
  rmSync(packageTarget, { recursive: true, force: true })
  mkdirSync(resolve(packageTarget, ".."), { recursive: true })
  cpSync(packageSource, packageTarget, { recursive: true, dereference: true })
}

// The native accessibility worker (ax_control) is built from this repository
// and copied by scripts/sync-worker.mjs; no third-party desktop binary ships.
// Drop a stale copy of the retired agent-desktop package from resources.
rmSync(resolve(root, "src-tauri/resources/node_modules/agent-desktop"), { recursive: true, force: true })
