// Copy the freshly built ax_control worker into the bundled resources.
// Runs via build.beforeBundleCommand: cargo has finished, so the worker
// binary exists and bundling has not started yet.
// - Cross-compilation (--target triple) puts output under target/<triple>/<profile>.
// - Mobile platforms have no desktop worker and skip cleanly.
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")

if (process.platform !== "darwin") {
  console.warn(`[sync-worker] ${process.platform} 无桌面 ax_control worker，跳过`)
  process.exit(0)
}
const mobilePlatform = ["android", "ios"].includes(process.env.TAURI_ENV_PLATFORM ?? "")
if (mobilePlatform) {
  console.warn("[sync-worker] mobile 构建不需要桌面 worker，跳过")
  process.exit(0)
}

const profile = process.env.TAURI_ENV_DEBUG ? "debug" : "release"
const targetRoot = resolve(root, "src-tauri/target")
const requestedTriple = process.env.TAURI_ENV_TARGET || process.env.TARGET || ""
const candidates = [
  requestedTriple && resolve(targetRoot, requestedTriple, profile, "ax_control"),
  resolve(targetRoot, profile, "ax_control"),
  ...readdirSync(targetRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== "debug" && entry.name !== "release")
    .map(entry => resolve(targetRoot, entry.name, profile, "ax_control")),
].filter(Boolean)
const source = candidates.find(path => existsSync(path))
const target = resolve(root, "src-tauri/resources/computer-use/ax_control")

if (!source) {
  console.error(`[sync-worker] 未找到 ${profile}/ax_control；已检查 ${candidates.join(", ")}`)
  process.exit(1)
}
copyFileSync(source, target)
// Rust's linker adds an ad-hoc signature to Mach-O executables. Tauri also
// discovers src/bin/ax_control and copies that source into Contents/MacOS,
// so clearing only the resource copy does not prevent codesign from trying to
// replace the source signature. Clear both copies before Tauri bundles and
// signs the app's executable contents.
const codesignTimeout = Number(process.env.ORBIT_CODESIGN_TIMEOUT_MS ?? 15_000)
const clearSignature = (path) => execFileSync(
  "/usr/bin/codesign",
  ["--remove-signature", path],
  { stdio: "inherit", timeout: codesignTimeout },
)

clearSignature(source)
clearSignature(target)
const { size } = statSync(target)
console.log(`[sync-worker] ax_control (${source} ${profile}) ${(size / 1024 / 1024).toFixed(1)} MB → resources/computer-use/ (signatures cleared)`)
