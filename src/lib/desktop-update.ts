import { create } from "zustand"
import { toast as gooeyToast } from "../shared/ui/toast";

type UpdateHandle = import("@tauri-apps/plugin-updater").Update

type DesktopUpdateState = {
  /** Live updater handle; non-null while a desktop update is offered. */
  update: UpdateHandle | null
  version: string
  body: string
  installing: boolean
  /** Record a fresh offer; returns true when the UI should surface it (new version). */
  offer: (update: UpdateHandle, version: string, body: string) => boolean
  setInstalling: (installing: boolean) => void
}

export const useDesktopUpdate = create<DesktopUpdateState>(set => ({
  update: null,
  version: "",
  body: "",
  installing: false,
  offer: (update, version, body): boolean => {
    const known: DesktopUpdateState = useDesktopUpdate.getState()
    set({ update, version, body, installing: false })
    return known.update == null || known.version !== version
  },
  setInstalling: installing => set({ installing }),
}))

/** Download + install the offered desktop update, then relaunch. Safe to call once. */
export async function installDesktopUpdate() {
  const state = useDesktopUpdate.getState()
  if (!state.update || state.installing) return
  state.setInstalling(true)
  try {
    const installation = state.update.downloadAndInstall()
    gooeyToast.promise(installation, {
      loading: "正在下载更新",
      success: "更新已安装，正在重启",
      error: "更新安装失败",
      showTimestamp: false,
    })
    await installation
    const { relaunch } = await import("@tauri-apps/plugin-process")
    await relaunch()
  } catch {
    // gooeyToast.promise already surfaced the failure; keep the offer so the
    // sidebar button (or a later check) can retry.
    state.setInstalling(false)
  }
}
