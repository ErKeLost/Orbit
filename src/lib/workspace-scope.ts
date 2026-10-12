import { projectExtraRoots, useProjects } from "./projects";
import { changeSession, connect, setSessionRoots } from "./rpc";
import { useWorkspace, type WorkspaceMode } from "./store";

/**
 * 从 UI（项目栏、composer 的范围选择器）切到一个工作范围：注册的项目，或
 * 「不在文件夹里工作」的主目录（home 模式）。
 *
 * 进入一个范围总是落在首页（EmptySession）：不自动把上次的会话翻出来。连接
 * 本来就在线（同一范围再点一次，或那个项目的进程还活着）时，才需要显式开一个
 * 新会话；否则 `connect` 用 `restoreLast: false` 起的新进程本身就是空的。
 *
 * 项目模式会顺带同步项目的附加 roots，让会话状态立刻拿到最新的目录列表。
 */
export async function openWorkspaceScope(path: string, mode: WorkspaceMode) {
  const workspace = useWorkspace.getState();
  const sameScope = workspace.cwd === path && workspace.workspaceMode === mode && workspace.connection === "online";
  if (!sameScope) await connect(path, mode, { restoreLast: false });
  // 已在线且带着消息：切到首页，而不是留着上一个会话。正在跑的一轮不打断。
  const transcript = useWorkspace.getState().transcript;
  if (transcript.messages.length > 0 && !transcript.running) {
    await changeSession({ type: "new_session" });
  }
  if (mode !== "project") return;
  const project = useProjects.getState().projects.find((item) => item.path === path);
  if (project) await setSessionRoots(projectExtraRoots(project));
}
