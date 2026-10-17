import { access, constants } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { DriverUnavailableError } from "./errors.ts"

/**
 * The Cua Driver executable. On macOS the CLI is a symlink into
 * `CuaDriver.app`, and the daemon it launches is what holds the Accessibility
 * and Screen Recording grants — so the binary must resolve to the app bundle,
 * never to a copied runtime.
 */
const CANDIDATES = [
  process.env.ORBIT_CUA_DRIVER_BIN,
  resolve("/Applications/CuaDriver.app/Contents/MacOS/cua-driver"),
  resolve(homedir(), ".local/bin/cua-driver"),
  resolve(homedir(), ".cua-driver/bin/cua-driver"),
].filter((value): value is string => Boolean(value))

/** Absolute path to `cua-driver`, or a structured error the caller can report. */
export async function resolveCuaDriver(): Promise<string> {
  for (const candidate of CANDIDATES) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch { /* keep looking */ }
  }
  throw new DriverUnavailableError(
    "未找到 cua-driver。请先安装 Cua Driver：curl -fsSL https://cua.ai/driver/install.sh | bash",
    "DRIVER_UNAVAILABLE",
  )
}

export type PermissionReport = {
  accessibility: boolean
  screenRecording: boolean
  bundleId?: string
  pid?: number
}

/**
 * Both grants belong to CuaDriver.app, not to Orbit. This only reports them;
 * it never tries to obtain them, because only the user can toggle them.
 */
export function assertGranted(report: PermissionReport): void {
  const missing = [
    report.accessibility ? undefined : "辅助功能 (Accessibility)",
    report.screenRecording ? undefined : "屏幕录制 (Screen Recording)",
  ].filter((value): value is string => Boolean(value))
  if (!missing.length) return
  throw new DriverUnavailableError(
    `Cua Driver 缺少授权：${missing.join("、")}。请在 系统设置 → 隐私与安全性 中为 CuaDriver 打开，然后重试`,
    "DRIVER_NOT_GRANTED",
    report,
  )
}

/**
 * Fail fast when the driver is connected but not granted.
 *
 * Called once right after connecting. Without this the first tool call fails
 * mid-run and the loop has to guess a permission problem from an error string,
 * which is exactly the misclassification a structured code prevents.
 *
 * Screen Recording is required only when this run will actually capture pixels
 * (`needsScreen`): an accessibility-only run does not need it, and demanding it
 * would reject a configuration that works.
 */
export async function assertDriverPermissions(
  driver: { checkPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean }> },
  options: { needsScreen?: boolean } = {},
): Promise<void> {
  const state = await driver.checkPermissions()
  assertGranted({
    accessibility: state.accessibility,
    screenRecording: options.needsScreen === true ? state.screenRecording : true,
  })
}
