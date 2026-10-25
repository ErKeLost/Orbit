import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useWorkspace } from "../../lib/store";
import { workspaceTabs } from "../shell/use-workspace-tabs";
import { report, sendPrompt } from "../../lib/rpc";

/** `quick_composer.rs` 投递过来的载荷。 */
type QuickPayload = { text: string; cwd: string };

/** 主窗口把当前范围写给 quick composer（两个窗口同源）。 */
const SCOPE_KEY = "orbit.quickScope";

/**
 * Quick composer 的落点。
 *
 * 收到那段文字之后只有两种去处，选哪个取决于用户当时在看什么：
 *
 * - 小窗说的目录正是**当前这条会话**的目录 → 直接送进这个连接，文字出现在你
 *   正看着的那段对话里；
 * - 否则 → 开一个**后台标签页**（`openBackground`），不抢焦点、跑完留在侧栏。
 *
 * 这样「随手写一句」既不会把你从手上的东西里拽走，也不会把话丢进错误的会话。
 */
export function useQuickSend(): void {
  const cwd = useWorkspace((state) => state.cwd);
  // 范围跟着主窗口走：小窗打开时标题栏就是对的。
  useEffect(() => {
    try {
      localStorage.setItem(SCOPE_KEY, cwd);
    } catch {
      /* 私密模式：小窗只会显示「没有项目」 */
    }
  }, [cwd]);

  useEffect(() => {
    const stop = listen<QuickPayload>("orbit:quick-send", (event) => {
      const text = event.payload.text?.trim();
      if (!text) return;
      void dispatch(text, event.payload.cwd || cwd).catch(report);
    });
    return () => void stop.then((off) => off());
  }, [cwd]);
}

async function dispatch(text: string, scope: string) {
  const viewing = useWorkspace.getState();
  // 正在看的这条会话就在小窗说的目录里：就地送出去。
  if (viewing.cwd === scope && viewing.connectionId && viewing.connection === "online") {
    await sendPrompt({ type: "prompt", message: text }, viewing.connectionId, false);
    return;
  }
  // 不在：开一条后台会话，别把用户的视线挪走。
  await workspaceTabs.openBackground(scope, { prompt: text });
}
