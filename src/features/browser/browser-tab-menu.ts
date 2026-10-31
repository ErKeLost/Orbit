import { Menu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { browserViewSetAudioMuted } from "../../lib/browser-view";
import { useWorkspace } from "../../lib/store";
import { useShell } from "../shell/shellStore";

/** Native menus stay above the native browser view, including when the tab is in PiP. */
export async function showBrowserTabMenu(path: string, x: number, y: number) {
  const state = useShell.getState();
  const index = state.browserTabs.findIndex(tab => tab.path === path);
  if (index < 0) return;
  const tab = state.browserTabs[index];
  const close = (mode: "current" | "others" | "right" | "all") => () => useShell.getState().closeBrowserTabs(path, mode);
  const menu = await Menu.new({ items: [
    { id: "toggle-mute", text: tab.audioMuted ? "取消标签页静音" : "将标签页静音", enabled: useWorkspace.getState().runtimePlatform === "macos", action: () => {
      void browserViewSetAudioMuted(path, !tab.audioMuted).then(() => useShell.getState().updateBrowser(path, { audioMuted: !tab.audioMuted })).catch(reportMenuFailure);
    } },
    { id: "close", text: "关闭标签页", action: close("current") },
    { id: "close-others", text: "关闭其他标签页", enabled: state.browserTabs.length > 1, action: close("others") },
    { id: "close-to-right", text: "关闭右侧标签页", enabled: index < state.browserTabs.length - 1, action: close("right") },
    { id: "close-all", text: "关闭全部标签页", action: close("all") },
  ] });
  try { await menu.popup(new LogicalPosition(x, y)); }
  finally { await menu.close(); }
}

export function reportMenuFailure(error: unknown) {
  // Lazy loading keeps the menu independent from toast rendering and its native surfaces.
  void import("../../shared/ui/toast").then(({ toast }) => toast.error("浏览器操作失败", { description: error instanceof Error ? error.message : String(error) }));
}
