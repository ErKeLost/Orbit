import { useWorkspace } from "../../../lib/store";
import { useShell } from "../../shell/shellStore";

/**
 * 从对话里点开一份产物。
 *
 * 产物住在「产物」那一页，而入口散在对话、列表、将来的搜索里，所以这里是一个
 * **只做一次跳转**的小闸门：切到那一页，把 id 交给正在听的读者页。页面还没挂上
 * 的时候先记着，挂上就立刻拿走——否则第一条点击会因为「页面还没渲染」而丢掉。
 */
let pending: string | null = null;
const listeners = new Set<(id: string) => void>();

export function openArtifact(id: string): void {
  if (!id) return;
  useWorkspace.getState().set({ panel: "artifacts" });
  if (listeners.size > 0) {
    for (const listener of listeners) listener(id);
    return;
  }
  pending = id;
}

/**
 * 在右栏读一份产物（对话里那张卡片的落点）。
 *
 * 「在外部展示」：对话保持是对话，页面另开一栏。这样长页面不会把回复撑开，
 * 也不会因为滚动位置而丢掉你正在读的那一段。
 */
export function openArtifactPanel(id: string): void {
  if (!id) return;
  const shell = useShell.getState();
  shell.setInspectorOpen(true);
  shell.setInspectorArtifact(id);
}

export function subscribeArtifactOpen(listener: (id: string) => void): () => void {
  listeners.add(listener);
  if (pending) {
    const id = pending;
    pending = null;
    listener(id);
  }
  return () => {
    listeners.delete(listener);
  };
}
