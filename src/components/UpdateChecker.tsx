import { useEffect } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { getVersion } from "@tauri-apps/api/app"
import { toast as gooeyToast } from "../shared/ui/toast";
import { useWorkspace } from "../lib/store"
import { installDesktopUpdate, useDesktopUpdate } from "../lib/desktop-update"
import { checkMobileUpdate, type MobileUpdate } from "../lib/mobile-update"

const RETRY_DELAY_MS = 3_000

type DesktopUpdateOptions = { notifyNoUpdate?: boolean }

export async function installMobileUpdate(update: MobileUpdate) {
  const installation = invoke("mobile_update_install", {
    url: update.downloadUrl,
    version: update.version,
  })
  gooeyToast.promise(installation, {
    loading: "正在下载 Android 更新，网络不好可能较慢",
    success: "下载完成，请在系统界面确认安装",
    error: "Android 更新下载失败，网络不稳定请稍后重试",
    showTimestamp: false,
  })
  await installation
}

export function offerMobileUpdate(update: MobileUpdate) {
  // 只出标题和操作按钮：release notes 长文案（英文、多行）在通知里没有阅读价值。
  gooeyToast.info(`发现 Orbit ${update.version}`, {
    duration: Infinity,
    showTimestamp: false,
    action: {
      label: "下载并安装",
      onClick: () => void installMobileUpdate(update),
    },
  })
}

export async function checkForDesktopUpdate({ notifyNoUpdate = false }: DesktopUpdateOptions = {}) {
  const current = await getVersion()
  const { check } = await import("@tauri-apps/plugin-updater")
  const update = await check()
  if (!update) {
    if (notifyNoUpdate) gooeyToast.success(`当前已是最新版本（${current}）`, { showTimestamp: false })
    return null
  }
  // The store keeps a persistent offer for the sidebar button; only toast when
  // the offered version actually changed so focus/online retries don't stack.
  const isNewOffer = useDesktopUpdate.getState().offer(update, update.version, update.body || "")
  if (isNewOffer) {
    gooeyToast.info(`发现 Orbit ${update.version}`, {
      duration: Infinity,
      showTimestamp: false,
      action: { label: "更新并重启", onClick: () => void installDesktopUpdate() },
    })
  }
  return update
}

export function UpdateChecker() {
  const runtimeTarget = useWorkspace(state => state.runtimeTarget)
  useEffect(() => {
    if ((runtimeTarget !== "desktop" && runtimeTarget !== "mobile") || import.meta.env.DEV || !isTauri()) return

    let disposed = false
    let checking = false
    const checkOnce = async () => {
      if (disposed || checking || document.visibilityState === "hidden") return
      checking = true
      try {
        if (runtimeTarget === "mobile") {
          const update = await checkMobileUpdate(await getVersion())
          if (update && !disposed) offerMobileUpdate(update)
          return
        }
        if (!disposed) await checkForDesktopUpdate()
      } catch (error) {
        if (!disposed) gooeyToast.warning("自动更新检查失败", {
          description: `${error instanceof Error ? error.message : String(error)}；网络恢复后会自动重试。`,
          showTimestamp: false,
        })
        throw error
      } finally {
        checking = false
      }
    }
    const retry = () => { void checkOnce().catch(() => undefined) }
    const startup = window.setTimeout(retry, RETRY_DELAY_MS)
    window.addEventListener("online", retry)
    window.addEventListener("focus", retry)
    // The main window mounts hidden behind the splashscreen, so the startup
    // check above gets skipped while document.hidden. Re-run when the window
    // becomes visible; without this a fresh launch never checks again until
    // an unrelated focus/online event happens to fire.
    document.addEventListener("visibilitychange", retry)
    return () => {
      disposed = true
      window.clearTimeout(startup)
      window.removeEventListener("online", retry)
      window.removeEventListener("focus", retry)
      document.removeEventListener("visibilitychange", retry)
    }
  }, [runtimeTarget])

  return null
}
